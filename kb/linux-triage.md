# Linux general triage (slow / crashing / full / won't start a service)

## First 60 seconds
- `uptime` (load vs core count), `inxi -Fxxxz` (one-shot system summary — feed this to the model),
  `dmesg -T --level=err,warn | tail`, `journalctl -p err -b --no-pager | tail`.

## Slow / high load
- CPU: `top`/`btop` — one process? `pidstat 1`. I/O wait high (`%wa`) ⇒ disk. `iostat -xz 1`, `iotop`.
- Memory: `free -h`; swapping? `dmesg | grep -i oom` (OOM killer). A leaking process ⇒ `ps aux --sort=-rss | head`.
- Thermal throttling: `sensors`; `turbostat`/`powertop`. Fans/temps high ⇒ dust/failing fan.

## Disk full
- `df -h` (inodes too: `df -i`). `ncdu /` or `du -x -d1 / | sort -h`. Common: `/var/log`,
  journald, docker overlay2, old kernels, `.m2`/caches.

## Service won't start
- `systemctl status <svc>`, `journalctl -u <svc> -b --no-pager`. Config test (nginx -t, sshd -t).
  Port in use? `ss -lntp`. Permission/SELinux/AppArmor denial? `dmesg | grep -i denied`.

## Won't boot (see boot-repair)
- Kernel panic / no init ⇒ initramfs/fstab. GRUB rescue ⇒ bootloader. Emergency mode ⇒ a failed
  mount in fstab (comment it / `nofail`). Check `journalctl -b -1 -p err` from the live rescue.

## Hardware suspicion
- Disk: `smartctl -a /dev/sdX` (Reallocated/Pending sectors, `nvme smart-log`). RAM: `memtester`
  or boot memtest86+; ECC errors: `edac-util`. Stress: `stress-ng`. Bus errors: `dmesg` MCE lines.
