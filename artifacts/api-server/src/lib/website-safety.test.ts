import assert from "node:assert/strict";
import test from "node:test";
import { publicIpAddress } from "./website-safety";

test("rejects private and special-purpose IPv4 addresses", () => {
  for (const address of [
    "10.0.0.1",
    "127.0.0.1",
    "169.254.10.8",
    "172.20.0.1",
    "192.0.0.8",
    "192.168.0.1",
    "198.18.0.1",
    "198.51.100.5",
    "203.0.113.5",
    "224.0.0.1",
  ]) {
    assert.equal(publicIpAddress(address), false, address);
  }
});

test("rejects mapped, compatible, and full IPv6 link-local ranges", () => {
  for (const address of [
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::192.168.0.1",
    "fe80::1",
    "febf::1",
    "fc00::1",
    "ff02::1",
    "2001:db8::1",
  ]) {
    assert.equal(publicIpAddress(address), false, address);
  }
});

test("allows globally routable IPv4 and IPv6 addresses", () => {
  assert.equal(publicIpAddress("8.8.8.8"), true);
  assert.equal(publicIpAddress("2606:4700:4700::1111"), true);
});