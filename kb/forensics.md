# Incident triage / forensics — read-only first, preserve evidence

Goal: figure out whether a box was compromised, and preserve what happened, without destroying
the evidence while looking. Order matters — volatile data dies first.

## Order of volatility (collect in this order)
1. Running processes, network connections, logged-in users, kernel modules, clock state —
   gone at the next reboot or even the next few minutes of normal activity.
2. Memory contents — gone at reboot, degrades as the system keeps running.
3. Disk contents — persists, but can still be overwritten by continued use.
4. Logs already rotated/shipped elsewhere — most durable, least volatile.

## Volatile data (do this before anything else, before even considering a reboot)
- `ps auxef`, `lsof -nP` (open files + listening sockets tied to a PID), `ss -tulpn` (listening
  + established connections with PIDs). Cross-reference: a process in `ps` with no matching
  binary at its claimed path (`ls -la /proc/<pid>/exe`) is a strong signal.
- `w`/`who`, `last -a` for login history, `lastb` for failed logins (brute-force signal).
- `lsmod` for loaded kernel modules — an unfamiliar module name is worth checking against
  `modinfo`.
- Current `date`/`timedatectl` vs. a known-good external time source — a manipulated clock can
  be covering for manipulated log timestamps.
- If memory capture is in scope and the tooling is available: `avml` or LiME to dump RAM before
  anything else touches the box further. This is the one step that becomes impossible later.

## Rootkit / persistence checks
- `rkhunter --check` / `chkrootkit` — treat "warning" results as leads to verify, not verdicts;
  both tools have a meaningful false-positive rate.
- Persistence mechanisms to check explicitly: cron (`crontab -l` for every user, plus
  `/etc/cron.*`), systemd timers/services (`systemctl list-unit-files --state=enabled` for
  anything unfamiliar), `/etc/rc.local`, shell profile files (`.bashrc`/`.profile` for an
  unexpected append), `LD_PRELOAD` (global `/etc/ld.so.preload` or in a user's environment).
- `authorized_keys` for every user, and `/etc/ssh/sshd_config` for an unexpected
  `AuthorizedKeysFile` pointing somewhere else or a weakened `PermitRootLogin`/`PasswordAuthentication`.
- Unexpected SUID binaries: `find / -perm -4000 -type f 2>/dev/null` compared against a
  known-good baseline if one exists for this box's distro/image.

## Timeline construction
- `journalctl --since "<window>"` scoped tightly around the suspected incident window, not the
  whole history — a multi-week journal dump defeats the point of a timeline.
- File timestamps: `find / -newer /some/reference-file -type f 2>/dev/null` to find anything
  touched since a known-good point (a last-patch date, a last-known-good backup time).
- Correlate auth logs (`journalctl -u sshd`, `/var/log/auth.log` if present), sudo usage, and
  the process/network snapshot above into one ordered sequence, not three separate lists.

## Preserve evidence
- Never run repair/cleanup tools (rkhunter `--propupd`, package reinstalls, log rotation) before
  evidence is captured — each of those can destroy exactly what you're trying to find.
- Image disks read-only the same way as kb/disk-smart.md's `ddrescue` step, before any
  filesystem-level investigation that could write to the disk.
- Copy logs/outputs off-box (or at minimum hash them: `sha256sum`) before any further action, so
  a "did we accidentally modify evidence" question has an answer.

## Safety
This whole skill is READ-ONLY collection + analysis. Remediation (killing a process, rotating
compromised credentials, rebuilding a box) is a separate, explicitly confirmed step — never
automatic, and never before evidence is preserved. See
../docs/specs/pi-rescue-spec.md and AGENTS.md.
