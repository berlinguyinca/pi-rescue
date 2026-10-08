# Fiehnlab pragmatic hardening playbook (docker/GPU-safe)

Applied by `fiehnlab-harden.sh`; `harden-existing.sh` applies it to a running box.
Goal: strong, automated hardening that does NOT break docker/apptainer/GPU/desktop.

## SSH (key-only)
- `/etc/ssh/sshd_config.d/10-*.conf` (10- so it wins over 50-cloud-init): `PasswordAuthentication no`,
  `KbdInteractiveAuthentication no`, `PermitRootLogin no`, `AllowUsers <admin>`, `X11Forwarding no`,
  idle timeout. Keep `MaxAuthTries` at the default 6 (lower locks out agents offering several keys).
- Verify with `sudo sshd -T | grep -Ei 'passwordauth|permitroot|allowusers'` — that is authoritative,
  not a behavioral test (a loaded agent key can still log in and look like "password worked").

## Host firewall (ufw)
- default deny incoming; allow 22 from anywhere (key-only); metrics ports from RFC1918 + Tailscale
  (100.64/10) only. Close the docker-bypasses-ufw hole with the ufw-docker DOCKER-USER block in
  `/etc/ufw/after.rules`. NEVER run `ufw enable` inside an install chroot — only on the real kernel.

## sysctl (docker-safe)
- `rp_filter=2` (loose; strict=1 breaks docker's many interfaces / multi-homing), no redirects,
  no source-route, syncookies, `kptr_restrict=2`, `dmesg_restrict=1`, `yama.ptrace_scope=1`,
  `fs.protected_*`, `suid_dumpable=0`. DO NOT touch `ip_forward`, user-namespaces, bridge-nf
  (docker/apptainer need them).

## Auto-updates (no auto-reboot)
- unattended-upgrades, security origins. Blacklist `nvidia-driver-*`, `libnvidia-*`,
  `nvidia-container*`, `docker.io`, `containerd` so a patch can't cause a driver mismatch or restart
  dockerd (killing jobs) on a box that never auto-reboots.

## Also
- Lock root (`passwd -l root`); AppArmor enforced; lightweight auditd (identity/sudo/sshd/privileged
  exec); disable unused daemons (headless: avahi/cups/bluetooth/ModemManager/whoopsie).
- Residual accepted: Secure Boot OFF (NVIDIA DKMS). No fail2ban (key-only SSH defeats brute force).
