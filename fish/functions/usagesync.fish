# Hourly usage collector for the agent-usage repository (my-pi/extensions/usage/collect.mjs).
# Runs on the host, never in an omp session: git over SSH fails inside nono.
#
# Needs ~/.pi/usage/config.json with { "repo": "~/github/agent-usage" } and that checkout cloned.
# Started by my-pi-start; loaded through my-pi/fish/conf.d/my-pi.fish.
# Requires: node >= 23.6 (store.mjs imports the secret redactor's .ts source), omp and git on PATH.
function usagesync --description 'Hourly omp usage collection and git sync to the agent-usage repo'
    set -l logfile ~/.local/state/usagesync.log
    set -l pidfile ~/.local/state/usagesync.pid
    set -l collector (path resolve (path dirname (path resolve (functions --details usagesync)))/../../extensions/usage/collect.mjs)
    set -l pid
    test -f $pidfile; and set pid (cat $pidfile)
    # A pid the system reused for another process does not count as running.
    if test -n "$pid"; and not string match -q -- "*collect.mjs*" (ps -p $pid -o command= 2>/dev/null)
        set pid
    end

    switch "$argv[1]"
        case '' start
            if test -n "$pid"
                echo "usagesync: already running (pid $pid, log: $logfile)"
                return 0
            end
            if not test -f ~/.pi/usage/config.json
                echo "usagesync: ~/.pi/usage/config.json missing; not started (see my-pi/extensions/usage/index.ts)"
                return 0
            end
            mkdir -p (path dirname $logfile)
            # DEV-NOTE: stdin from /dev/null for the same reason as ghmcp: a background
            # node with a tty stdin is stopped by SIGTTIN.
            nohup node --no-warnings $collector --loop </dev/null >>$logfile 2>&1 &
            set -l started $last_pid
            disown
            echo $started >$pidfile
            command sleep 1
            if not kill -0 $started 2>/dev/null
                echo "usagesync: exited (pid $started); see $logfile" >&2
                return 1
            end
            echo "usagesync: up, hourly (pid $started, log: $logfile)"
        case stop
            if test -z "$pid"
                echo "usagesync: not running"
                return 0
            end
            kill -TERM $pid
            rm -f $pidfile
            echo "usagesync: stopped (pid $pid)"
        case status
            if test -z "$pid"
                echo "usagesync: not running"
                return 1
            end
            echo "usagesync: running (pid $pid)"
            tail -n 1 $logfile
        case now backfill
            # DEV-NOTE: a second collector in the same checkout races the loop's git commands (index.lock).
            if test -n "$pid"
                echo "usagesync: the hourly loop is running (pid $pid); run: usagesync stop; usagesync $argv[1]; usagesync start" >&2
                return 1
            end
            # backfill: all session logs and limit history this device still has; merges, so safe to repeat.
            if test "$argv[1]" = backfill
                node --no-warnings $collector --backfill
            else
                node --no-warnings $collector
            end
        case log
            tail -f $logfile
        case '*'
            echo "usage: usagesync [start|stop|status|now|backfill|log]" >&2
            return 2
    end
end
