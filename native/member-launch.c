#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

// Linux 6.1 headers omit the ABI 3 constant; the runtime kernel version is checked before use.
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (UINT64_C(1) << 14)
#endif

static void fail(void) { perror("Native member isolation"); _exit(126); }
static void checked(long value) { if (value < 0) fail(); }
static unsigned long number(const char *text, unsigned long max) {
    char *end;
    if (!text || !*text) fail();
    unsigned long n = strtoul(text, &end, 10);
    if (*end || n == 0 || n > max) fail();
    return n;
}

static void permit(int rules, const char *path, uint64_t access, int optional) {
    int fd = open(path, O_PATH | O_CLOEXEC);
    if (fd < 0 && optional && (errno == ENOENT || errno == ENOTDIR)) return;
    checked(fd);
    struct landlock_path_beneath_attr attr = { .allowed_access = access, .parent_fd = fd };
    checked(syscall(SYS_landlock_add_rule, rules, LANDLOCK_RULE_PATH_BENEATH, &attr, 0));
    checked(close(fd));
}

static void port(int rules, const char *value) {
    struct { uint64_t access, port; } attr = { 2, number(value, 65535) };
    checked(syscall(SYS_landlock_add_rule, rules, 2 /* LANDLOCK_RULE_NET_PORT */, &attr, 0));
}

// Descendants stay in the invocation process group supervised by the host.
static void keep_group(void) {
    struct sock_filter code[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
#if defined(__aarch64__)
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_AARCH64, 1, 0),
#elif defined(__x86_64__)
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
#else
#error Unsupported native member architecture
#endif
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_setsid, 2, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_setpgid, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    };
    struct sock_fprog filter = { .len = sizeof(code)/sizeof(code[0]), .filter = code };
    checked(prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &filter));
}

int main(int argc, char **argv) {
    const char *codex = getenv("BIRBCREW_NATIVE_BINARY");
    if (!codex && argc < 3) return 126;
    pid_t parent = number(codex ? getenv("BIRBCREW_NATIVE_PARENT") : argv[1], INT_MAX);
    checked(prctl(PR_SET_PDEATHSIG, SIGKILL));
    if (getppid() != parent) return 126;
    char executable[PATH_MAX];
    if (!realpath(codex ? codex : argv[2], executable)) fail();
    int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < (codex ? 4 : 3)) return 126;
    uint64_t handled = (UINT64_C(1) << (abi >= 5 ? 16 : 15)) - 1;
    struct { uint64_t fs, net; } ruleset = { handled, codex ? 3 : 0 };
    int rules = syscall(SYS_landlock_create_ruleset, &ruleset, codex ? sizeof(ruleset) : sizeof(uint64_t), 0);
    checked(rules);
    uint64_t read = LANDLOCK_ACCESS_FS_READ_FILE, list = LANDLOCK_ACCESS_FS_READ_DIR;
    uint64_t write = LANDLOCK_ACCESS_FS_WRITE_FILE, exec = LANDLOCK_ACCESS_FS_EXECUTE;
    uint64_t private = read | list | write | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
        LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK |
        LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE;
    permit(rules, executable, read | exec, 0);
    const char *readable[] = {"/etc/ld.so.cache","/etc/resolv.conf","/etc/hosts","/etc/nsswitch.conf","/etc/ssl/openssl.cnf",
        "/etc/gai.conf","/etc/localtime","/dev/random","/dev/urandom","/proc/meminfo","/proc/self/maps","/proc/self/stat",
        "/proc/self/status","/proc/self/statm","/proc/self/cgroup","/proc/sys/vm/overcommit_memory","/proc/sys/vm/mmap_min_addr",
        "/proc/cpuinfo","/proc/stat","/sys/devices/system/cpu/online",NULL};
    for (int i = 0; readable[i]; i++) permit(rules, readable[i], read, 1);
    permit(rules, "/etc/ssl/certs", read | list, 1);
    permit(rules, "/dev/null", read | write, 0);
    if (codex) {
        const char *home = getenv("CODEX_HOME"), *scratch = getenv("BIRBCREW_NATIVE_WORKSPACE");
        if (!home || !scratch) return 126;
        checked(chdir(scratch));
        permit(rules, home, private, 0);
        permit(rules, scratch, read | list, 0);
        port(rules, getenv("BIRBCREW_NATIVE_PROVIDER_PORT"));
        if (getenv("BIRBCREW_NATIVE_MCP_PORT")) port(rules, getenv("BIRBCREW_NATIVE_MCP_PORT"));
        unsetenv("BIRBCREW_NATIVE_BINARY"); unsetenv("BIRBCREW_NATIVE_PARENT"); unsetenv("BIRBCREW_NATIVE_WORKSPACE");
        unsetenv("BIRBCREW_NATIVE_PROVIDER_PORT"); unsetenv("BIRBCREW_NATIVE_MCP_PORT");
        argv[0] = executable;
    } else {
        const char *lib[] = {"/usr/lib","/usr/lib64","/lib64",NULL};
        for (int i = 0; lib[i]; i++) permit(rules, lib[i], read | list | exec, 1);
        permit(rules, ".", private, 0);
        argv += 2;
    }
    checked(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0));
    keep_group();
    checked(syscall(SYS_landlock_restrict_self, rules, 0));
    umask(0077);
    checked(syscall(SYS_close_range, 3, UINT_MAX, 0));
    execv(executable, argv);
    fail();
}
