# Network triage — single host (link → internet)

Work the ladder top-down; stop at the first layer that fails.

## 1. Physical link / carrier
- `ip -br link` — is the interface UP? `ethtool <if>` — "Link detected: yes"? Speed/duplex sane?
- No **carrier** (not just admin "UP") ⇒ cable unplugged / dead port / bad SFP. (Real case: an
  install failed with only `lo` up — the NIC showed `Link UP` but never "Gained carrier"; the
  Ethernet cable simply wasn't in a live port. Check carrier before anything else.)
- Wi-Fi: `nmcli dev wifi`, `wavemon` for signal.

## 2. DHCP / address
- `ip -br addr` — got a v4 address? Only `127.0.0.1`/`::1` ⇒ no lease.
- No lease with carrier present ⇒ no DHCP server on that segment, slow server, or wrong VLAN.
  Try `sudo dhclient -v <if>` and watch for DHCPOFFER. Check the DHCP server / MikroTik leases.
- Static expected? Verify netplan/NetworkManager config.

## 3. Gateway / routing
- `ip route` — is there a default route? `ping <gateway>` — reachable?
- No default route ⇒ DHCP gave none, or static config missing `gateway4`.

## 4. DNS
- `resolvectl status` / `cat /etc/resolv.conf`. `dig example.com` vs `dig @1.1.1.1 example.com`.
- Resolves via public resolver but not the configured one ⇒ bad/unreachable DNS server.
- `realmd: No default domain received via DHCP` is informational, not the fault.

## 5. Path / MTU
- `mtr -rwzbc20 1.1.1.1` — where do loss/latency start? `ping -M do -s 1472 <host>` for MTU/PMTU
  black-holes (tunnels/VPN). Asymmetric routing ⇒ check both directions.

## 6. Local firewall
- `sudo ufw status verbose` / `sudo nft list ruleset`. Default-deny can block return traffic if
  established/related isn't allowed. Docker-published ports bypass ufw (see DOCKER-USER).

## Fast facts
- apt/install needs working DNS + a default route + the archive reachable; a packageless install
  failure (`curtin ... --download-only <pkg>` exit 100) is almost always "no network", not disk.
