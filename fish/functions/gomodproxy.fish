# Go module proxy for omp sessions in `nono --profile pi`. Started from a host shell, never by
# the agent: the sandbox side is GOPROXY/GONOPROXY in the nono profile's environment.set_vars.
#
# Loaded through my-pi/fish/conf.d/my-pi.fish; the my-pi setup extension reports when it is down.
# Requires: go with GOPRIVATE set; node >= 24.2.
function gomodproxy --description 'Go module proxy on 127.0.0.1:8083 (GOPRIVATE fetched on the host)'
    set -l port 8083
    set -l logfile ~/.local/state/gomodproxy.log
    set -l proxy (path resolve (path dirname (path resolve (functions --details gomodproxy)))/../../mcp/gomod/proxy.mjs)
    set -l listening (lsof -t -nP -iTCP:$port -sTCP:LISTEN 2>/dev/null)

    switch "$argv[1]"
        case '' start
            if test -n "$listening"
                echo "gomodproxy: port $port already in use (pid $listening)"
                return 0
            end
            mkdir -p (path dirname $logfile)
            # DEV-NOTE: stdin from /dev/null for the same reason as ghmcp: a background
            # node with a tty stdin is stopped by SIGTTIN.
            nohup node $proxy </dev/null >$logfile 2>&1 &
            set -l pid $last_pid
            disown
            for i in (seq 10)
                if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1
                    echo "gomodproxy: up on http://127.0.0.1:$port (log: $logfile)"
                    return 0
                end
                if not kill -0 $pid 2>/dev/null
                    echo "gomodproxy: exited; see $logfile" >&2
                    return 1
                end
                command sleep 1
            end
            echo "gomodproxy: not listening after 10 s; see $logfile" >&2
            return 1
        case stop
            if test -z "$listening"
                echo "gomodproxy: not running"
                return 0
            end
            kill -TERM $listening
            echo "gomodproxy: stopped (pid $listening)"
        case status
            if test -z "$listening"
                echo "gomodproxy: not running"
                return 1
            end
            lsof -nP -iTCP:$port -sTCP:LISTEN
        case log
            tail -f $logfile
        case '*'
            echo "usage: gomodproxy [start|stop|status|log]" >&2
            return 2
    end
end
