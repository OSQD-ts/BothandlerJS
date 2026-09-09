/**
 * IP parsing, normalisation and CIDR matching, with no dependencies.
 *
 * Everything works on raw byte arrays rather than strings, because string
 * comparison of IPs is a classic source of bypasses: `::ffff:127.0.0.1`,
 * `0177.0.0.1` and `127.0.0.001` are all the same host to the network stack but
 * three different strings to a naive allowlist.
 */

/** An IP as bytes: 4 for IPv4, 16 for IPv6. IPv4-mapped IPv6 is folded to 4. */
export type IpBytes = Uint8Array;

/**
 * Parses an IPv4 or IPv6 literal into bytes, or `null` if it is not a valid
 * address. Deliberately strict: no octal, no hex, no shorthand octets, no zone
 * ids. Anything ambiguous is rejected rather than guessed at.
 */
/**
 * An address with its source port removed, when it carried one.
 *
 * Forwarded headers are not consistent about this. Most proxies write a bare address,
 * but Azure's Application Gateway and Front Door write `1.2.3.4:5678`, and the
 * bracketed `[2001:db8::1]:5678` is the form RFC 7239 defines for IPv6. An entry that
 * carries a port parses as nothing at all, and the consequence is not that one entry is
 * skipped: every entry in the chain looks the same way, the chain empties, and the whole
 * internet collapses onto the proxy's own address as a single actor. Rate limits, actor
 * history and reputation then apply to everyone at once, so one bot locks out every real
 * visitor — and none of it announces itself.
 *
 * The rule has to be narrow, because a bare IPv6 address is *made of* colons and must
 * never be mistaken for a host and port. Only two shapes are a port: a bracketed host,
 * which is unambiguous, and a single colon whose left side is an IPv4 address. Anything
 * with more colons and no brackets is IPv6 and is returned untouched.
 */
export function stripPort(value: string): string {
  const input = value.trim();
  if (input.startsWith("[")) {
    const close = input.indexOf("]");
    if (close > 0) return input.slice(1, close);
    return input;
  }
  const colon = input.indexOf(":");
  // Exactly one colon: IPv6 always has at least two, so this can only be host:port.
  if (colon === -1 || input.indexOf(":", colon + 1) !== -1) return input;
  const host = input.slice(0, colon);
  return parseIpv4(host) !== null ? host : input;
}

export function parseIp(value: string): IpBytes | null {
  const input = value.trim();
  if (input.length === 0 || input.length > 45) return null;
  // Bracketed form from a Host/Forwarded header: [2001:db8::1]
  const bare = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  if (bare.includes(":")) return parseIpv6(bare);
  return parseIpv4(bare);
}

function parseIpv4(value: string): IpBytes | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i]!;
    // Reject empty, over-long, non-digit and leading-zero forms outright.
    if (part.length === 0 || part.length > 3) return null;
    if (!/^\d+$/.test(part)) return null;
    if (part.length > 1 && part[0] === "0") return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

function parseIpv6(value: string): IpBytes | null {
  // Strip a zone id (`%eth0`) — it is a local routing detail, not part of identity.
  const withoutZone = value.split("%")[0]!;
  const doubleColon = withoutZone.indexOf("::");
  if (doubleColon !== withoutZone.lastIndexOf("::")) return null;

  const [headText, tailText] =
    doubleColon === -1
      ? [withoutZone, ""]
      : [withoutZone.slice(0, doubleColon), withoutZone.slice(doubleColon + 2)];

  const head = headText.length > 0 ? headText.split(":") : [];
  const tail = tailText.length > 0 ? tailText.split(":") : [];

  // A trailing dotted-quad (`::ffff:192.0.2.1`) occupies the last two groups.
  let embedded: IpBytes | null = null;
  const groups = [...head, ...tail];
  const last = groups[groups.length - 1];
  if (last !== undefined && last.includes(".")) {
    embedded = parseIpv4(last);
    if (!embedded) return null;
    if (tail.length > 0) tail.pop();
    else head.pop();
  }

  const groupCount = head.length + tail.length + (embedded ? 2 : 0);
  if (doubleColon === -1 ? groupCount !== 8 : groupCount > 7) return null;

  const bytes = new Uint8Array(16);
  let offset = 0;
  for (const group of head) {
    if (!writeGroup(bytes, offset, group)) return null;
    offset += 2;
  }
  // The gap the `::` stands for, left as the zeroes the array already holds.
  offset = 16 - tail.length * 2 - (embedded ? 4 : 0);
  for (const group of tail) {
    if (!writeGroup(bytes, offset, group)) return null;
    offset += 2;
  }
  if (embedded) bytes.set(embedded, 12);

  // Fold IPv4-mapped (::ffff:0:0/96) down to a plain v4 address so that one host
  // has exactly one representation regardless of which stack accepted it.
  if (isIpv4Mapped(bytes)) return bytes.slice(12, 16);
  return bytes;
}

function writeGroup(bytes: Uint8Array, offset: number, group: string): boolean {
  if (group.length === 0 || group.length > 4 || !/^[0-9a-fA-F]+$/.test(group)) return false;
  const n = Number.parseInt(group, 16);
  bytes[offset] = n >> 8;
  bytes[offset + 1] = n & 0xff;
  return true;
}

function isIpv4Mapped(bytes: Uint8Array): boolean {
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/** Canonical string form, so the same host always produces the same actor key. */
export function formatIp(bytes: IpBytes): string {
  if (bytes.length === 4) return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  // RFC 5952: compress the longest run of zero groups, leftmost on a tie.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] !== "0") continue;
    let j = i;
    while (j < 8 && groups[j] === "0") j++;
    if (j - i > bestLen) {
      bestLen = j - i;
      bestStart = i;
    }
    i = j;
  }
  if (bestLen < 2) return groups.join(":");
  return `${groups.slice(0, bestStart).join(":")}::${groups.slice(bestStart + bestLen).join(":")}`;
}

/** Normalises any accepted spelling of an address to its canonical form. Returns `null` if unparseable. */
export function normalizeIp(value: string): string | null {
  const bytes = parseIp(value);
  return bytes ? formatIp(bytes) : null;
}

export interface Cidr {
  readonly bytes: IpBytes;
  readonly prefix: number;
  readonly source: string;
}

/** Parses `"10.0.0.0/8"`, `"2001:db8::/32"`, or a bare address (treated as a /32 or /128). */
export function parseCidr(value: string): Cidr | null {
  const slash = value.lastIndexOf("/");
  const addressText = slash === -1 ? value : value.slice(0, slash);
  const bytes = parseIp(addressText);
  if (!bytes) return null;
  const maxPrefix = bytes.length * 8;
  if (slash === -1) return { bytes, prefix: maxPrefix, source: value };
  const prefixText = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > maxPrefix) return null;
  return { bytes, prefix, source: value };
}

/** True when `ip` falls inside `cidr`. Address families never match across each other. */
export function cidrContains(cidr: Cidr, ip: IpBytes): boolean {
  if (cidr.bytes.length !== ip.length) return false;
  const fullBytes = cidr.prefix >> 3;
  for (let i = 0; i < fullBytes; i++) if (cidr.bytes[i] !== ip[i]) return false;
  const remainder = cidr.prefix & 7;
  if (remainder === 0) return true;
  const mask = 0xff << (8 - remainder);
  return (cidr.bytes[fullBytes]! & mask) === (ip[fullBytes]! & mask);
}

/**
 * One range plus the position it was added at, so that when several ranges match the
 * same address the answer does not depend on how the index happens to be laid out.
 */
interface IndexedCidr {
  readonly cidr: Cidr;
  readonly order: number;
}

/**
 * Ranges for one address family, indexed on the first two bytes.
 *
 * A linear scan is fine for the handful of CIDRs in an allowlist and catastrophic for
 * the list this library actually asks operators to supply: AWS publishes around seven
 * thousand IPv4 prefixes, GCP and Azure comparable numbers, and `datacenterRanges` is
 * documented as the place to put them. Scanning that on every request measured at
 * ~87µs — several times the cost of the entire rest of an assessment — so the size of
 * a range list silently became the dominant term in request latency.
 *
 * Bucketing by the leading bytes fixes that without changing any answer. A prefix of
 * /16 or longer pins both leading bytes, so it is reachable from exactly one bucket;
 * a /8 to /15 pins only the first; anything shorter than /8 spans buckets and stays in
 * a list checked on every lookup. Real range lists are overwhelmingly /16 and longer,
 * which is why this collapses to a handful of comparisons.
 */
class FamilyIndex {
  /** Prefix < 8. Spans first bytes, so it is always scanned. Realistically empty. */
  private readonly wide: IndexedCidr[] = [];
  private readonly buckets = new Map<number, { mid: IndexedCidr[]; deep: Map<number, IndexedCidr[]> }>();

  add(entry: IndexedCidr): void {
    const { cidr } = entry;
    if (cidr.prefix < 8) {
      this.wide.push(entry);
      return;
    }
    const first = cidr.bytes[0]!;
    let bucket = this.buckets.get(first);
    if (bucket === undefined) {
      bucket = { mid: [], deep: new Map() };
      this.buckets.set(first, bucket);
    }
    if (cidr.prefix < 16) {
      bucket.mid.push(entry);
      return;
    }
    const second = cidr.bytes[1]!;
    let deep = bucket.deep.get(second);
    if (deep === undefined) {
      deep = [];
      bucket.deep.set(second, deep);
    }
    deep.push(entry);
  }

  /** The earliest-added range containing `ip`, or `undefined`. */
  find(ip: IpBytes): IndexedCidr | undefined {
    let best = scan(this.wide, ip, undefined);
    const bucket = this.buckets.get(ip[0]!);
    if (bucket !== undefined) {
      best = scan(bucket.mid, ip, best);
      const deep = bucket.deep.get(ip[1]!);
      if (deep !== undefined) best = scan(deep, ip, best);
    }
    return best;
  }
}

function scan(entries: readonly IndexedCidr[], ip: IpBytes, best: IndexedCidr | undefined): IndexedCidr | undefined {
  let winner = best;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (winner !== undefined && entry.order > winner.order) continue;
    if (cidrContains(entry.cidr, ip)) winner = entry;
  }
  return winner;
}

/**
 * A compiled set of CIDR ranges. Building it once and reusing it keeps the hot
 * path free of string parsing — matching is a handful of byte comparisons, and stays
 * that way as the list grows into the thousands.
 */
export class IpRangeSet {
  private readonly v4 = new FamilyIndex();
  private readonly v6 = new FamilyIndex();
  private count = 0;
  /**
   * Every range that parsed, in the order it was added.
   *
   * Kept as plain text beside the index rather than reconstructed from it. The index
   * is shaped for lookups — bucketed by leading byte, prefix-split — and walking it
   * back into a list would be both slower and, for anything that wants to *show* the
   * set, wrong: what an operator recognises is the string they wrote, not a normalised
   * form of it. These sets are configuration-sized, so the array costs nothing.
   */
  private readonly sources: string[] = [];
  /** Ranges that failed to parse, surfaced so a typo in config is loud rather than silent. */
  readonly invalid: string[] = [];

  constructor(ranges: Iterable<string> = []) {
    for (const range of ranges) this.add(range);
  }

  add(range: string): void {
    const cidr = parseCidr(range);
    if (!cidr) {
      this.invalid.push(range);
      return;
    }
    this.sources.push(cidr.source);
    (cidr.bytes.length === 4 ? this.v4 : this.v6).add({ cidr, order: this.count++ });
  }

  get size(): number {
    return this.count;
  }

  /** The ranges in this set, as written, oldest first. What a reader can act on. */
  entries(): readonly string[] {
    return this.sources;
  }

  /**
   * Returns the matching range's original text, or `undefined`. Useful for explaining
   * a decision. When several ranges match, the one added first wins, so the
   * explanation does not depend on the index's internal layout.
   */
  match(ip: string | IpBytes): string | undefined {
    const bytes = typeof ip === "string" ? parseIp(ip) : ip;
    if (!bytes) return undefined;
    return (bytes.length === 4 ? this.v4 : this.v6).find(bytes)?.cidr.source;
  }

  contains(ip: string | IpBytes): boolean {
    const bytes = typeof ip === "string" ? parseIp(ip) : ip;
    if (!bytes) return false;
    return (bytes.length === 4 ? this.v4 : this.v6).find(bytes) !== undefined;
  }
}

/** IANA special-purpose ranges: loopback, private, link-local, CGNAT, documentation. */
export const SPECIAL_USE_RANGES = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "2001:db8::/32",
] as const;

const SPECIAL_USE = new IpRangeSet(SPECIAL_USE_RANGES);

/** True for loopback/private/link-local/documentation addresses — never public clients. */
export function isSpecialUse(ip: string): boolean {
  return SPECIAL_USE.contains(ip);
}

/**
 * Masks an address to a coarse network for rate accounting: /24 for IPv4, /64 for
 * IPv6. IPv6 clients routinely get a whole /64 to themselves and rotate the host
 * bits freely, so per-address counting is trivially defeated there.
 */
export function networkKey(ip: string): string {
  const bytes = parseIp(ip);
  if (!bytes) return ip;
  // Build the masked address at full width. Slicing to three bytes and formatting
  // that would produce a 3-byte array, which `formatIp` reads as IPv6.
  if (bytes.length === 4) {
    const masked = new Uint8Array([bytes[0]!, bytes[1]!, bytes[2]!, 0]);
    return `${formatIp(masked)}/24`;
  }
  const masked = new Uint8Array(16);
  masked.set(bytes.subarray(0, 8), 0);
  return `${formatIp(masked)}/64`;
}
