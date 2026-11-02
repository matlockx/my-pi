# Puts my-pi/fish/functions in front of fish_function_path, so functions added
# to the repo are available after `git pull` and a new shell, and take
# precedence over same-named copies in ~/.config/fish/functions.
#
# Linked once per Mac by setup.fish at the repo root, run from a host shell
# (the omp sandbox cannot write ~/.config):
#   fish ~/github/my-pi/setup.fish
# The my-pi setup extension reports the command when the link is missing.
set -l my_pi_functions (path dirname (path dirname (path resolve (status filename))))/functions
if not contains -- $my_pi_functions $fish_function_path
    set -g fish_function_path $my_pi_functions $fish_function_path
end
