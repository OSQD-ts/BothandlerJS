import { describe, expect, it } from "vitest";
import { IpRangeSet, formatIp, isSpecialUse, networkKey, normalizeIp, parseCidr, parseIp, stripPort } from "../src/internal/ip.js";
import { BotHandler } from "../src/index.js";

describe("parseIp", () => {
  it("parses plain IPv4", () => {
    expect(Array.from(parseIp("192.0.2.1")!)).toEqual([192, 0, 2, 1]);
  });

  // Each of these is a classic allowlist bypass: a spelling the network stack
  // accepts and a string comparison does not recognise.
  it.each(["0177.0.0.1", "127.0.0.001", "127.1", "0x7f.0.0.1", "192.0.2.1.", "256.0.0.1", " 192.0.2.1 x"])(
    "rejects the ambiguous form %s",
    (input) => {
      expect(parseIp(input)).toBeNull();
    },
  );

  it("folds IPv4-mapped IPv6 to a single canonical form", () => {
    expect(normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeIp("::FFFF:127.0.0.1")).toBe("127.0.0.1");
  });

  it("round-trips compressed IPv6 through RFC 5952 formatting", () => {
    expect(normalizeIp("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
    expect(normalizeIp("[2001:db8::1]")).toBe("2001:db8::1");
  });

  it("strips a zone id, which is routing detail rather than identity", () => {
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80::1");
  });

  it("rejects a second :: compression", () => {
    expect(parseIp("2001::db8::1")).toBeNull();
  });
});

describe("IpRangeSet", () => {
  // The index buckets on the leading bytes; these are the cases where that could
  // diverge from a plain scan, so they are checked against one directly.
  it("agrees with an exhaustive scan across prefix lengths and families", () => {
    const ranges = ["0.0.0.0/4", "10.0.0.0/8", "172.16.0.0/12", "192.0.2.0/24", "198.51.100.7", "2001:db8::/32", "2001:db8:1::/48", "fe80::/10"];
    const set = new IpRangeSet(ranges);
    const probes = ["0.0.0.1", "8.8.8.8", "10.1.2.3", "11.0.0.1", "172.15.255.255", "172.16.0.1", "172.31.255.255", "172.32.0.1", "192.0.2.0", "192.0.3.0", "198.51.100.7", "198.51.100.8", "2001:db8::1", "2001:db8:1::1", "2001:db9::1", "fe80::1", "fec0::1"];
    for (const probe of probes) {
      const scanned = ranges.filter((range) => new IpRangeSet([range]).contains(probe));
      expect(set.match(probe), probe).toBe(scanned[0]);
    }
  });

  // A range list is realistically thousands of entries — AWS alone publishes about
  // seven thousand — so the index has to stay correct at that size, not only exact.
  it("stays exact across a range list the size of a cloud provider's", () => {
    const ranges = Array.from({ length: 5000 }, (_, i) => `${3 + (i % 220)}.${(i * 7) % 256}.${(i * 13) % 256}.0/24`);
    const set = new IpRangeSet(ranges);
    for (const range of ranges) {
      const [a, b, c] = range.split(".");
      expect(set.contains(`${a}.${b}.${c}.42`), range).toBe(true);
    }
    expect(set.contains("1.2.3.4")).toBe(false);
    expect(set.contains("2.0.0.1")).toBe(false);
  });

  // Which range explains a decision must not depend on the index's internal layout.
  it("reports the range added first when several overlap", () => {
    expect(new IpRangeSet(["10.0.0.0/8", "10.1.0.0/16"]).match("10.1.2.3")).toBe("10.0.0.0/8");
    expect(new IpRangeSet(["10.1.0.0/16", "10.0.0.0/8"]).match("10.1.2.3")).toBe("10.1.0.0/16");
  });

  it("matches inside and outside a v4 prefix", () => {
    const set = new IpRangeSet(["10.0.0.0/8", "192.0.2.128/25"]);
    expect(set.match("10.255.255.255")).toBe("10.0.0.0/8");
    expect(set.match("192.0.2.200")).toBe("192.0.2.128/25");
    expect(set.contains("192.0.2.127")).toBe(false);
    expect(set.contains("11.0.0.1")).toBe(false);
  });

  it("never matches across address families", () => {
    const set = new IpRangeSet(["0.0.0.0/0"]);
    expect(set.contains("2001:db8::1")).toBe(false);
  });

  it("is not fooled by an alternative spelling of a loopback address", () => {
    const set = new IpRangeSet(["127.0.0.0/8"]);
    expect(set.contains("::ffff:127.0.0.1")).toBe(true);
  });

  it("collects invalid entries rather than silently dropping them", () => {
    const set = new IpRangeSet(["10.0.0.0/8", "not-an-ip", "10.0.0.0/64"]);
    expect(set.invalid).toEqual(["not-an-ip", "10.0.0.0/64"]);
    expect(set.size).toBe(1);
  });

  it("handles a /0 and a full-length prefix", () => {
    expect(new IpRangeSet(["0.0.0.0/0"]).contains("8.8.8.8")).toBe(true);
    expect(new IpRangeSet(["8.8.8.8"]).contains("8.8.8.9")).toBe(false);
  });
});

describe("helpers", () => {
  it("recognises special-use ranges", () => {
    expect(isSpecialUse("10.1.2.3")).toBe(true);
    expect(isSpecialUse("::1")).toBe(true);
    expect(isSpecialUse("8.8.8.8")).toBe(false);
  });

  it("masks to a coarse network for accounting", () => {
    expect(networkKey("192.0.2.55")).toBe("192.0.2.0/24");
    expect(networkKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
  });

  it("treats a bare address as a full-length prefix", () => {
    expect(parseCidr("192.0.2.1")?.prefix).toBe(32);
    expect(parseCidr("2001:db8::1")?.prefix).toBe(128);
  });

  it("formats v4 bytes back to dotted quad", () => {
    expect(formatIp(parseIp("203.0.113.9")!)).toBe("203.0.113.9");
  });
});

/**
 * Forwarded headers are not consistent about ports. Azure's Application Gateway and
 * Front Door write `1.2.3.4:5678`, and RFC 7239 defines `[2001:db8::1]:5678` for IPv6.
 * An entry carrying one used to parse as nothing, and because every entry in such a
 * chain looks the same way the chain emptied and the whole internet collapsed onto the
 * proxy's own address as one actor — so a single bot's rate limit locked out every real
 * visitor, silently.
 *
 * The danger in the fix is the opposite mistake: a bare IPv6 address is made of colons
 * and must never be read as a host and a port.
 */
describe("addresses that arrive with a port", () => {
  it("removes a port where there is one", () => {
    expect(stripPort("1.2.3.4:51234")).toBe("1.2.3.4");
    expect(stripPort("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(stripPort("[2001:db8::1]")).toBe("2001:db8::1");
    expect(stripPort("  1.2.3.4:80  ")).toBe("1.2.3.4");
  });

  it("never mistakes an IPv6 address for a host and a port", () => {
    for (const address of ["2001:db8::1", "::1", "::", "2001:db8:0:0:0:0:0:1", "::ffff:1.2.3.4", "fe80::1%eth0"]) {
      expect(stripPort(address), address).toBe(address);
    }
  });

  it("leaves alone what is not an address with a port", () => {
    expect(stripPort("1.2.3.4")).toBe("1.2.3.4");
    expect(stripPort("evil.test:80")).toBe("evil.test:80");
    expect(stripPort(":8080")).toBe(":8080");
    expect(stripPort("[2001:db8::1")).toBe("[2001:db8::1");
  });
});

describe("resolving a client address behind a proxy that writes ports", () => {
  const socket = "198.51.100.7";

  it("reads a chain whose entries carry ports", () => {
    const handler = new BotHandler({ onWarning: () => {}, proxy: { trustProxy: true } });
    expect(handler.resolveIp(socket, { "x-forwarded-for": "1.2.3.4:51234" })).toBe("1.2.3.4");
    expect(handler.resolveIp(socket, { "x-forwarded-for": "[2001:db8::1]:443" })).toBe("2001:db8::1");
  });

  it("does not collapse every client onto the proxy", () => {
    // The bug this replaced: with an Azure-style proxy every request resolved to the
    // socket address, so every visitor shared one actor and one rate-limit bucket.
    const handler = new BotHandler({ onWarning: () => {}, proxy: { trustProxy: true } });
    const seen = new Set<string>();
    for (let i = 1; i < 20; i++) seen.add(handler.resolveIp(socket, { "x-forwarded-for": `203.0.113.${i}:4000` }));
    expect(seen.size).toBe(19);
    expect(seen.has(socket)).toBe(false);
  });

  it("still refuses to let a client choose its own address", () => {
    // Understanding ports must not become a way to smuggle a chosen address in.
    const hop = new BotHandler({ onWarning: () => {}, proxy: { trustProxy: true } });
    expect(hop.resolveIp(socket, { "x-forwarded-for": "9.9.9.9:1, 8.8.8.8:2, 1.2.3.4:3" })).toBe("1.2.3.4");

    const trusted = new BotHandler({ onWarning: () => {}, proxy: { trustProxy: true, trustedProxies: ["198.51.100.0/24"] } });
    expect(trusted.resolveIp(socket, { "x-forwarded-for": "1.2.3.4:9, 198.51.100.9:80" })).toBe("1.2.3.4");
    // Claiming to be the proxy, port and all, must not hide anyone.
    expect(trusted.resolveIp(socket, { "x-forwarded-for": "198.51.100.9:1, 198.51.100.9:2" })).toBe(socket);

    const hops = new BotHandler({ onWarning: () => {}, proxy: { trustProxy: true, hops: 2 } });
    // Padding the left of the chain must not shift an index counted from the right.
    expect(hops.resolveIp(socket, { "x-forwarded-for": "7.7.7.7, 6.6.6.6:1, 1.2.3.4, 5.6.7.8" })).toBe("1.2.3.4");
  });

  it("keeps the header ignored entirely when it is not trusted", () => {
    const handler = new BotHandler({ onWarning: () => {} });
    expect(handler.resolveIp(socket, { "x-forwarded-for": "1.2.3.4:5678" })).toBe(socket);
  });
});
