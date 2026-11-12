# Jira MCP (sooperset/mcp-atlassian, Jira only) behind the MCP guard, for omp sessions. Started
# from a host shell, never by the agent: the omp side is only the `jira` http entry in my-pi/mcp.json.
# my-pi/mcp/jira/guard.mjs holds the API token in memory and starts mcp-atlassian on 18084.
#
# Loaded through my-pi/fish/conf.d/my-pi.fish.
# Requires: brew install uv; node >= 24.2; acli logged in (site and e-mail are taken from
# `acli jira auth status`); a Jira API token (https://id.atlassian.com/manage-profile/security/api-tokens)
# in the login keychain:
#   security add-generic-password -U -s jira-mcp -a <e-mail> -w
function jiramcp --description 'Jira MCP (mcp-atlassian behind the MCP guard) on 127.0.0.1:8084'
    set -l port 8084
    set -l logfile ~/.local/state/jiramcp.log
    set -l guard (path resolve (path dirname (path resolve (functions --details jiramcp)))/../../mcp/jira/guard.mjs)
    set -l listening (lsof -t -nP -iTCP:$port -sTCP:LISTEN 2>/dev/null)

    switch "$argv[1]"
        case '' start
            if test -n "$listening"
                echo "jiramcp: already running on http://127.0.0.1:$port/mcp (pid $listening, log: $logfile)"
                return 0
            end
            if not command -q uvx
                echo "jiramcp: uvx not found (brew install uv); not started" >&2
                return 1
            end
            set -l auth (acli jira auth status 2>/dev/null)
            set -l site (string match -rg '^\s*Site:\s*(\S+)' -- $auth)
            set -l email (string match -rg '^\s*Email:\s*(\S+)' -- $auth)
            if test -z "$site" -o -z "$email"
                echo "jiramcp: acli is not logged in (acli jira auth login); not started" >&2
                return 1
            end
            # DEV-NOTE: presence check only; guard.mjs reads the token itself, so it is in no
            # shell variable or process environment.
            if not security find-generic-password -s jira-mcp -a $email >/dev/null 2>&1
                echo "jiramcp: no Jira API token in the keychain; add it with: security add-generic-password -U -s jira-mcp -a $email -w" >&2
                return 1
            end
            mkdir -p (path dirname $logfile)
            # DEV-NOTE: stdin from /dev/null for the same reason as ghmcp: a background
            # process with a tty stdin is stopped by SIGTTIN.
            nohup node $guard </dev/null >$logfile 2>&1 &
            set -l pid $last_pid
            disown
            # First start downloads the package, so allow longer than ghmcp.
            for i in (seq 60)
                set listening (lsof -t -nP -iTCP:$port -sTCP:LISTEN 2>/dev/null)
                if test -n "$listening"
                    echo "jiramcp: up on http://127.0.0.1:$port/mcp (pid $listening, log: $logfile)"
                    return 0
                end
                if not kill -0 $pid 2>/dev/null
                    echo "jiramcp: exited (pid $pid); see $logfile" >&2
                    return 1
                end
                command sleep 1
            end
            echo "jiramcp: not listening after 60 s (pid $pid); see $logfile" >&2
            return 1
        case stop
            if test -z "$listening"
                echo "jiramcp: not running"
                return 0
            end
            # The guard stops mcp-atlassian on SIGTERM.
            kill -TERM $listening
            echo "jiramcp: stopped (pid $listening)"
        case status
            if test -z "$listening"
                echo "jiramcp: not running"
                return 1
            end
            lsof -nP -iTCP:$port -sTCP:LISTEN
        case log
            tail -f $logfile
        case '*'
            echo "usage: jiramcp [start|stop|status|log]" >&2
            return 2
    end
end
