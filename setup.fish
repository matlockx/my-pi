#!/usr/bin/env fish
# One-time host setup of my-pi on a Mac. Idempotent: run it again after a
# `git pull` or whenever the omp setup check reports a todo.
#
# Run it from a host terminal, never from an omp session: the sandbox mounts
# ~/.config read-only, and the proxies must not run under the agent.
#
#   fish ~/github/my-pi/setup.fish
#
# Links AGENTS.md and the fish conf.d loader, moves shadowed copies of the
# repo's fish functions, installs missing Homebrew tools, logs gh in, drops a
# user-level "github" MCP entry that outranks my-pi/mcp.json, runs the MCP setup
# wizard (mcp/setup/wizard.mjs: which MCP servers to use, what each needs, the
# Kubernetes/AWS tier map), and copies the proxy starter to ~/bin/my-pi-start.
# The proxies are not started; run my-pi-start after each login.

set -l repo (path dirname (path resolve (status filename)))

# Points link at source. A regular file in the way is kept as a timestamped
# .bak; a link pointing elsewhere is replaced.
function __my_pi_link --argument-names source link
    if test (path resolve $link) = (path resolve $source)
        return
    end
    mkdir -p (path dirname $link)
    if test -e $link; and not test -L $link
        set -l backup $link.bak.(date +%Y%m%d%H%M%S)
        mv $link $backup
        echo "moved $link to $backup"
    end
    ln -sfn $source $link
    echo "linked $link -> $source"
end

__my_pi_link $repo/agents/AGENTS.md ~/.omp/agent/AGENTS.md
if test -d ~/.pi/agent
    __my_pi_link $repo/agents/AGENTS.md ~/.pi/agent/AGENTS.md
end
__my_pi_link $repo/fish/conf.d/my-pi.fish ~/.config/fish/conf.d/my-pi.fish

for fn in $repo/fish/functions/*.fish
    set -l copy ~/.config/fish/functions/(path basename $fn)
    if test -e $copy -o -L $copy; and test (path resolve $copy) != (path resolve $fn)
        # DEV-NOTE: kept as .bak (fish autoloads only *.fish) in case the copy held local edits.
        set -l backup $copy.bak.(date +%Y%m%d%H%M%S)
        mv $copy $backup
        echo "moved $copy to $backup (shadowed by $fn)"
    end
end

if not command -q brew
    echo "Homebrew not found: install it from https://brew.sh, then run this script again" >&2
    exit 1
end
# The GitHub MCP proxy needs node >= 24.2 (import.meta.main).
function __my_pi_node_ok
    command -q node; or return 1
    set -l v (node --version 2>/dev/null | string match -rg '^v(\d+)\.(\d+)')
    test (count $v) -eq 2; and begin
        test $v[1] -gt 24; or test $v[1] -eq 24 -a $v[2] -ge 2
    end
end

set -l formulae
for tool in gh jq uv
    command -q $tool; or set -a formulae $tool
end
__my_pi_node_ok; or set -a formulae node
if set -q formulae[1]
    # DEV-NOTE: brew install also upgrades an outdated, already installed formula (node).
    brew install $formulae; or exit 1
end
if not __my_pi_node_ok
    # DEV-NOTE: an nvm/asdf node earlier on PATH shadows the Homebrew node just installed.
    echo "warning: "(command -v node)" is "(node --version 2>/dev/null)", older than 24.2; put /opt/homebrew/bin first on PATH or install node 24.2+ with your version manager" >&2
end

if not gh auth status >/dev/null 2>&1
    gh auth login; or exit 1
end

set -l user_mcp ~/.omp/agent/mcp.json
if test -f $user_mcp; and jq -e '.mcpServers.github' $user_mcp >/dev/null 2>&1
    # DEV-NOTE: chmod before mv keeps the file private; it holds other servers' credentials.
    jq 'del(.mcpServers.github)' $user_mcp >$user_mcp.tmp
    and chmod 600 $user_mcp.tmp
    and mv $user_mcp.tmp $user_mcp
    and echo "removed the github entry from $user_mcp (my-pi/mcp.json provides it)"
end

if not command -q go
    echo "note: go not on PATH; gomodproxy needs it (brew install go)"
else
    set -l goprivate (go env GOPRIVATE)
    if test -z "$goprivate"
        echo "note: GOPRIVATE is empty, so gomodproxy will not start (go env -w GOPRIVATE=...)"
    end
end

# Asks per MCP server (GitHub, Jira, jflow) and for the Kubernetes/AWS tiers; installs or
# stores what each needs.
node $repo/mcp/setup/wizard.mjs; or exit 1

mkdir -p ~/bin
cp $repo/bin/my-pi-start ~/bin/my-pi-start
chmod 755 ~/bin/my-pi-start
fish_add_path ~/bin
echo "installed ~/bin/my-pi-start"

echo "done. Start the proxies now and after each login with my-pi-start (my-pi-start restart restarts them all), then run /mcp reconnect github and /mcp reconnect jira in omp."
