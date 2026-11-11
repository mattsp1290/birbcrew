"""Constrain the native Claude process and its descendants before exec."""
import ctypes
import signal
import os
from pathlib import Path
import resource
import sys


def checked(result):
    if result < 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return result


class Ruleset(ctypes.Structure):
    _fields_ = [("fs", ctypes.c_uint64)]


class PathRule(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


# Linux uses these Landlock syscall numbers on x64 and arm64.
create, add, restrict = 444, 445, 446
libc = ctypes.CDLL(None, use_errno=True)
# Reject a launch if the adapter died before the kernel installed the death signal.
checked(libc.prctl(1, signal.SIGKILL, 0, 0, 0))  # PR_SET_PDEATHSIG
if os.getppid() != int(sys.argv[1]):
    raise RuntimeError("Claude adapter exited before launch")

abi = checked(libc.syscall(create, 0, 0, 1))
if abi < 3:
    raise RuntimeError("Claude requires Landlock ABI 3 or newer")
execute, write, read, list_dir = 1, 2, 4, 8
refer, truncate = 1 << 13, 1 << 14
handled = (1 << (16 if abi >= 5 else 15)) - 1
ruleset = Ruleset(handled)
fd = checked(libc.syscall(create, ctypes.byref(ruleset), ctypes.sizeof(ruleset), 0))


def permit(path, access):
    file_fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
    try:
        rule = PathRule(access, file_fd)
        checked(libc.syscall(add, fd, 1, ctypes.byref(rule), 0))
    finally:
        os.close(file_fd)


executable = Path(sys.argv[2]).resolve()
permit(executable, read | execute)
for name in ["/usr/lib", "/lib64", "/usr/lib64", "/etc/ssl/certs"]:
    if os.path.isdir(name):
        permit(name, read | list_dir | (0 if name.startswith("/etc/") else execute))
for name in ["/etc/ld.so.cache", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf",
             "/etc/ssl/openssl.cnf", "/etc/gai.conf", "/etc/localtime", "/dev/random", "/dev/urandom",
             "/proc/meminfo", "/proc/self/maps", "/proc/self/stat", "/proc/self/statm", "/proc/self/cgroup",
             "/proc/sys/vm/overcommit_memory", "/proc/sys/vm/mmap_min_addr",
             "/proc/cpuinfo", "/proc/stat", "/sys/devices/system/cpu/online"]:
    if os.path.isfile(name) or name.startswith("/dev/"):
        permit(name, read)
permit("/dev/null", read | write)
# Allow regular files, directories, and local sockets in this conversation only.
permit(Path.cwd(), read | write | list_dir | (1 << 4) | (1 << 5) | (1 << 7) |
       (1 << 8) | (1 << 9) | refer | truncate)
checked(libc.prctl(38, 1, 0, 0, 0))  # PR_SET_NO_NEW_PRIVS
checked(libc.syscall(restrict, fd, 0))
os.close(fd)
os.umask(0o077)
# Claude speaks to the adapter over standard I/O only.
os.closerange(3, resource.getrlimit(resource.RLIMIT_NOFILE)[0])
os.execv(executable, sys.argv[2:])
