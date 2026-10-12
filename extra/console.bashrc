# Read by every interactive bash in the Docker image, which is what the Dockge
# console runs. Debian ships all of this switched off, so without it the
# console has a plain prompt and no colour from ls or grep.

case $- in
    *i*) ;;
    *) return ;;
esac

# The prompt Debian's own .bashrc uses once colour is on: green user@host,
# blue working directory
PS1='${debian_chroot:+($debian_chroot)}\[\033[01;32m\]\u@\h\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ '

if [ -x /usr/bin/dircolors ]; then
    eval "$(dircolors -b)"
    alias ls='ls --color=auto'
    alias grep='grep --color=auto'
fi

alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'
