import assert from "node:assert/strict";
import { test } from "node:test";
import type { CollectedOutput } from "../../src/skills/collectors.ts";
import {
  evaluateAddress,
  evaluateDns,
  evaluateFirewall,
  evaluateGatewayPing,
  evaluateLinkCarrier,
  evaluateMtu,
  evaluateRoute,
  parseDefaultGateway,
  runNetworkTriage,
} from "../../src/skills/networkTriage.ts";
import { collectingIO } from "../../src/skills/types.ts";

test("evaluateLinkCarrier: passes when a real interface is UP", () => {
  const output = [
    "lo               UNKNOWN        00:00:00:00:00:00",
    "eth0             UP             aa:bb:cc:dd:ee:ff",
  ].join("\n");
  const result = evaluateLinkCarrier(output);
  assert.equal(result.status, "pass");
  assert.match(result.detail, /eth0/);
});

test("evaluateLinkCarrier: fails when no real interface has carrier (the real fiehnlab incident)", () => {
  const output = [
    "lo               UNKNOWN        00:00:00:00:00:00",
    "eth0             DOWN           aa:bb:cc:dd:ee:ff",
  ].join("\n");
  const result = evaluateLinkCarrier(output);
  assert.equal(result.status, "fail");
  assert.match(result.detail, /cable/i);
});

test("evaluateLinkCarrier: ignores docker/veth/br/virbr noise so it never masks a real failure", () => {
  const output = [
    "lo               UNKNOWN        00:00:00:00:00:00",
    "docker0          UP             02:42:ac:11:00:01",
    "veth1234abc      UP             aa:bb:cc:dd:ee:00",
    "eth0             DOWN           aa:bb:cc:dd:ee:ff",
  ].join("\n");
  const result = evaluateLinkCarrier(output);
  assert.equal(result.status, "fail", "docker0/veth being UP must not hide eth0 being down");
});

test("evaluateAddress: passes with a real DHCP/static IPv4 address", () => {
  const output = "eth0             UP             192.168.1.42/24";
  assert.equal(evaluateAddress(output).status, "pass");
});

test("evaluateAddress: fails when the only address is link-local (no DHCP lease)", () => {
  const output = "eth0             UP             169.254.12.3/16";
  const result = evaluateAddress(output);
  assert.equal(result.status, "fail");
  assert.match(result.detail, /dhcp/i);
});

test("evaluateAddress: fails when there's no address at all", () => {
  const output = "eth0             UP             ";
  assert.equal(evaluateAddress(output).status, "fail");
});

test("evaluateRoute: passes and extracts the gateway from a default route", () => {
  const output = [
    "default via 192.168.1.1 dev eth0 proto dhcp metric 100",
    "192.168.1.0/24 dev eth0 proto kernel",
  ].join("\n");
  const result = evaluateRoute(output);
  assert.equal(result.status, "pass");
  assert.match(result.detail, /192\.168\.1\.1/);
});

test("evaluateRoute: fails with no default route", () => {
  const output = "192.168.1.0/24 dev eth0 proto kernel";
  assert.equal(evaluateRoute(output).status, "fail");
});

test("evaluateDns: passes when the configured resolver answers", () => {
  const result = evaluateDns("93.184.216.34", "93.184.216.34");
  assert.equal(result.status, "pass");
});

test("evaluateDns: fails and blames the configured resolver specifically when only the public one answers", () => {
  const result = evaluateDns("", "93.184.216.34");
  assert.equal(result.status, "fail");
  assert.match(result.detail, /configured/i);
});

test("evaluateDns: fails and points at routing/firewall, not DNS, when neither resolver answers", () => {
  const result = evaluateDns("", "");
  assert.equal(result.status, "fail");
  assert.match(result.detail, /routing|firewall/i);
});

test("parseDefaultGateway: extracts the gateway IP from a default route line", () => {
  assert.equal(parseDefaultGateway("default via 192.168.1.1 dev eth0 proto dhcp metric 100"), "192.168.1.1");
  assert.equal(parseDefaultGateway("192.168.1.0/24 dev eth0 proto kernel"), undefined);
});

const PING_OK = "1 packets transmitted, 1 received, 0% packet loss, time 0ms";
const PING_LOST = "1 packets transmitted, 0 received, 100% packet loss, time 0ms";

test("evaluateGatewayPing: passes on a normal reply", () => {
  assert.equal(evaluateGatewayPing(PING_OK, PING_OK).status, "pass");
});

test("evaluateGatewayPing: skips (not fails) when the gateway ignores ICMP but the internet is reachable", () => {
  const result = evaluateGatewayPing(PING_LOST, PING_OK);
  assert.equal(result.status, "skip");
  assert.match(result.detail, /ignore/i);
});

test("evaluateGatewayPing: fails when nothing answers a ping at all — gateway and internet both lost", () => {
  assert.equal(evaluateGatewayPing(PING_LOST, PING_LOST).status, "fail");
  assert.equal(evaluateGatewayPing("", "").status, "fail");
});

test("evaluateMtu: skips when even a baseline ping can't get through", () => {
  const result = evaluateMtu("", "");
  assert.equal(result.status, "skip");
});

test("evaluateMtu: passes when both a plain and a full-size don't-fragment ping succeed", () => {
  assert.equal(evaluateMtu(PING_OK, PING_OK).status, "pass");
});

test("evaluateMtu: fails — a path-MTU black hole — when the baseline works but the DF ping silently vanishes", () => {
  const result = evaluateMtu(PING_OK, PING_LOST);
  assert.equal(result.status, "fail");
  assert.match(result.detail, /mtu|fragment/i);
});

test("evaluateMtu: passes — PMTU discovery working, not a black hole — on an explicit 'frag needed' reply", () => {
  const fragNeeded = "ping: local error: Message too long, mtu=1492";
  const result = evaluateMtu(PING_OK, fragNeeded);
  assert.equal(result.status, "pass");
  assert.match(result.detail, /1492/);
});

test("evaluateMtu: skips (not fails) when the DF ping itself couldn't run (e.g. no raw-socket permission)", () => {
  const result = evaluateMtu(PING_OK, "");
  assert.equal(result.status, "skip");
});

function collected(ok: boolean, output: string): CollectedOutput {
  return { name: "x", command: "x", ok, output };
}

test("evaluateFirewall: reports ufw's status line when ufw answers", () => {
  const result = evaluateFirewall(collected(true, "Status: active\nLogging: on (low)"), undefined);
  assert.equal(result.status, "pass");
  assert.match(result.detail, /active/);
});

test("evaluateFirewall: falls back to nft when ufw doesn't answer", () => {
  const result = evaluateFirewall(collected(false, ""), collected(true, "table inet filter {\n}"));
  assert.equal(result.status, "pass");
});

test("evaluateFirewall: skips (not fails) when neither tool could be checked", () => {
  const result = evaluateFirewall(collected(false, ""), collected(false, ""));
  assert.equal(result.status, "skip");
});

test("runNetworkTriage: the report goes through io.report(), not io.print()", async () => {
  const io = collectingIO();
  const downLink = async (command: string, args: string[]) =>
    command === "ip" && args[0] === "-br" && args[1] === "link"
      ? { stdout: "eth0 DOWN aa:bb:cc:dd:ee:ff", stderr: "", code: 0 }
      : { stdout: "", stderr: "", code: 0 };
  await runNetworkTriage({ io, exec: downLink });
  assert.equal(io.reportLog.length, 1);
  assert.match(io.reportLog[0] ?? "", /cable/i);
  assert.ok(
    !io.log.some((line) => /cable/i.test(line)),
    "the report text must not also appear as a print() narration line",
  );
});

test("runNetworkTriage: a gateway that ignores ICMP doesn't stop the ladder short of DNS", async () => {
  const io = collectingIO();
  const exec: Parameters<typeof runNetworkTriage>[0]["exec"] = async (command, args) => {
    if (command === "ip" && args[0] === "-br" && args[1] === "link") {
      return { stdout: "eth0 UP aa:bb:cc:dd:ee:ff", stderr: "", code: 0 };
    }
    if (command === "ip" && args[0] === "-br" && args[1] === "addr") {
      return { stdout: "eth0 UP 192.168.1.42/24", stderr: "", code: 0 };
    }
    if (command === "ip" && args[0] === "route") {
      return { stdout: "default via 192.168.1.1 dev eth0", stderr: "", code: 0 };
    }
    if (command === "ping" && args.includes("192.168.1.1")) {
      return { stdout: PING_LOST, stderr: "", code: 0 }; // gateway ignores ICMP
    }
    if (command === "ping") {
      return { stdout: PING_OK, stderr: "", code: 0 }; // but the internet is reachable
    }
    if (command === "dig") {
      return { stdout: "93.184.216.34", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: null, failure: "ENOENT" };
  };
  const result = await runNetworkTriage({ io, exec });
  const gateway = result.rungs.find((r) => r.rung === "gateway");
  assert.equal(gateway?.status, "skip");
  assert.ok(
    result.rungs.some((r) => r.rung === "dns"),
    "DNS must still run after a skipped gateway rung",
  );
  assert.equal(result.firstFailure, undefined);
});
