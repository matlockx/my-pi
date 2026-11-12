# Jira MCP (sooperset/mcp-atlassian, Jira only) for omp sessions. Started from a host shell,
# never by the agent: the omp side is only the `jira` http entry in my-pi/mcp.json.
#
# Loaded through my-pi/fish/conf.d/my-pi.fish.
# Requires: brew install uv; acli logged in (site and e-mail are taken from
# `acli jira auth status`); a Jira API token (https://id.atlassian.com/manage-profile/security/api-tokens)
# in the login keychain:
#   security add-generic-password -U -s jira-mcp -a <e-mail> -w
function jiramcp --description 'Jira MCP (mcp-atlassian, read-write) on 127.0.0.1:8084'
    set -l port 8084
    set -l logfile ~/.local/state/jiramcp.log
    set -l workdir ~/.local/state/jiramcp
    # DEV-NOTE: pinned; uvx would otherwise run whatever PyPI serves at start time.
    set -l package mcp-atlassian@0.24.2
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
            set -l token (security find-generic-password -s jira-mcp -a $email -w 2>/dev/null)
            if test -z "$token"
                echo "jiramcp: no Jira API token in the keychain; add it with: security add-generic-password -U -s jira-mcp -a $email -w" >&2
                return 1
            end
            mkdir -p (path dirname $logfile) $workdir/files
            # DEV-NOTE: stdin from /dev/null for the same reason as ghmcp: a background
            # process with a tty stdin is stopped by SIGTTIN.
            # DEV-NOTE: --directory: mcp-atlassian loads ./.env, so it must not start in an
            # arbitrary project directory. --host: the default is 0.0.0.0.
            # MCP_ATLASSIAN_FILES_DIR: the only directory upload tools may read from.
            # ALLOW_GLOBAL_CRED_FALLBACK: omp sends no Authorization header; without it every
            # request fails with "Authentication required". Any local caller then uses the
            # configured Jira account, the same exposure as ghmcp and jflow mcp.
            # shortcut: the token is in the server's environment (readable by same-user
            # processes outside the sandbox); mcp-atlassian takes Cloud API tokens no other way.
            JIRA_URL=https://$site JIRA_USERNAME=$email JIRA_API_TOKEN=$token \
                MCP_ATLASSIAN_FILES_DIR=$workdir/files ALLOW_GLOBAL_CRED_FALLBACK=true \
                nohup uvx --directory $workdir $package --transport streamable-http --stateless \
                --host 127.0.0.1 --port $port </dev/null >$logfile 2>&1 &
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
            # uvx exits once its python child does.
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
