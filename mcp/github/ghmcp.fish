# GitHub MCP for omp sessions. Started from a host shell, never by the agent:
# the omp side is only the `github` http entry in my-pi/mcp.json.
#
# Install:  ln -sf ~/projects/my-pi/mcp/github/ghmcp.fish ~/.config/fish/functions/ghmcp.fish
# Requires: brew install github-mcp-server; gh auth login; node >= 24.2.
function ghmcp --description 'GitHub MCP (read-write) behind a token proxy on 127.0.0.1:8082'
    set -l port 8082
    set -l logfile ~/.local/state/ghmcp.log
    set -l proxy (path dirname (path resolve (functions --details ghmcp)))/proxy.mjs
    set -l listening (lsof -t -nP -iTCP:$port -sTCP:LISTEN 2>/dev/null)

    switch "$argv[1]"
        case '' start
            if test -n "$listening"
                echo "ghmcp: port $port already in use (pid $listening)"
                return 0
            end
            mkdir -p (path dirname $logfile)
            # DEV-NOTE: stdin must not be the terminal. macOS nohup leaves stdin alone, and
            # npm/node touch a tty stdin, which stops a background job with SIGTTIN (STAT T):
            # the port stays open but no request is ever answered.
            # DEV-NOTE: no token here. proxy.mjs reads `gh auth token` into memory, so the
            # token is in no process environment that `ps -E`/sysctl could expose.
            nohup node $proxy </dev/null >$logfile 2>&1 &
            set -l pid $last_pid
            disown
            for i in (seq 20)
                if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1
                    echo "ghmcp: up on http://127.0.0.1:$port/mcp (log: $logfile)"
                    return 0
                end
                if not kill -0 $pid 2>/dev/null
                    echo "ghmcp: proxy exited; see $logfile" >&2
                    return 1
                end
                # `command` bypasses a user-defined `sleep` function or alias.
                command sleep 1
            end
            echo "ghmcp: not listening after 20 s; see $logfile" >&2
            return 1
        case stop
            if test -z "$listening"
                echo "ghmcp: not running"
                return 0
            end
            # Signal the whole process group (proxy and github-mcp-server).
            # SIGCONT lets an already stopped group act on the SIGTERM.
            set -l pgid (ps -o pgid= -p $listening | string trim)
            kill -TERM -- -$pgid
            kill -CONT -- -$pgid 2>/dev/null
            echo "ghmcp: stopped (pid $listening, group $pgid)"
        case status
            if test -z "$listening"
                echo "ghmcp: not running"
                return 1
            end
            lsof -nP -iTCP:$port -sTCP:LISTEN
        case log
            tail -f $logfile
        case '*'
            echo "usage: ghmcp [start|stop|status|log]" >&2
            return 2
    end
end
