/**
 * Returns true only for addresses that are safe for a server-side public
 * website fetch. It deliberately rejects special-purpose address space.
 */
export function publicIpAddress(address: string): boolean {
  const normalized = address.toLowerCase();

  if (normalized.includes(":")) {
    return publicIpv6Address(normalized);
  }

  const octets = normalized.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [first, second, third] = octets;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 &&
      (second === 0 ||
        second === 168 ||
        second === 18 ||
        second === 19 ||
        (second === 31 && third === 196) ||
        (second === 52 && third === 193) ||
        (second === 88 && third === 99) ||
        (second === 175 && third === 48))) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0 && third === 113)
  );
}

function publicIpv6Address(address: string): boolean {
  if (address.includes(".")) {
    return false;
  }

  const halves = address.split("::");
  if (halves.length > 2) {
    return false;
  }
  const before = halves[0] ? halves[0].split(":") : [];
  const after = halves[1] ? halves[1].split(":") : [];
  const rawGroups = [...before, ...after];
  if (
    rawGroups.length > 8 ||
    rawGroups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))
  ) {
    return false;
  }

  const groups = [
    ...before.map((group) => Number.parseInt(group, 16)),
    ...Array(Math.max(0, 8 - rawGroups.length)).fill(0),
    ...after.map((group) => Number.parseInt(group, 16)),
  ];
  if (groups.length !== 8) {
    return false;
  }

  const [first, second] = groups;
  if (first < 0x2000 || first > 0x3fff) {
    return false;
  }

  return !(
    (first === 0x2001 &&
      (second === 0x0000 ||
        second === 0x0002 ||
        second === 0x0db8 ||
        (second >= 0x0010 && second <= 0x001f) ||
        (second >= 0x0020 && second <= 0x002f))) ||
    first === 0x2002
  );
}