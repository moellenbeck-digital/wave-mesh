/**
 * Asks a resolver one question, for the end-to-end test.
 *
 * Deliberately free of workspace imports: it runs from outside any package.
 */
const RecordType = { A: 1, AAAA: 28 } as const;

const [server, name, type = "A"] = process.argv.slice(2);
if (!server || !name) {
  console.error("usage: dnsquery.ts <resolver-ip> <name> [A|AAAA]");
  process.exit(2);
}

const recordType = type === "AAAA" ? RecordType.AAAA : RecordType.A;
const labels = name.split(".").filter(Boolean);
const body: number[] = [];
for (const label of labels) body.push(label.length, ...new TextEncoder().encode(label));
body.push(0);

const packet = new Uint8Array(12 + body.length + 4);
const view = new DataView(packet.buffer);
view.setUint16(0, 0x4242);
view.setUint16(2, 0x0100);
view.setUint16(4, 1);
packet.set(body, 12);
view.setUint16(12 + body.length, recordType);
view.setUint16(14 + body.length, 1);

const answer = Promise.withResolvers<Uint8Array | null>();
const socket = await Bun.udpSocket({
  socket: { data: (_s, data) => answer.resolve(new Uint8Array(data)) },
});
const timer = setTimeout(() => answer.resolve(null), 4000);
socket.send(packet, 53, server);

const reply = await answer.promise;
// Without this the open socket keeps the process alive for good.
clearTimeout(timer);
socket.close();
if (!reply) {
  console.error("no answer");
  process.exit(1);
}

const replyView = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
const count = replyView.getUint16(6);
let offset = 12;
const skipName = () => {
  while (reply[offset] !== 0) offset += (reply[offset] ?? 0) + 1;
  offset++;
};
skipName();
offset += 4;

const addresses: string[] = [];
for (let i = 0; i < count; i++) {
  skipName();
  const recordKind = replyView.getUint16(offset);
  const length = replyView.getUint16(offset + 8);
  const data = reply.subarray(offset + 10, offset + 10 + length);
  if (recordKind === RecordType.A) addresses.push(Array.from(data).join("."));
  if (recordKind === RecordType.AAAA) {
    const groups: string[] = [];
    for (let g = 0; g < 8; g++) groups.push(((data[g * 2] ?? 0) * 256 + (data[g * 2 + 1] ?? 0)).toString(16));
    addresses.push(groups.join(":"));
  }
  offset += 10 + length;
}

if (addresses.length === 0) {
  console.error(`no records (rcode ${replyView.getUint16(2) & 0xf})`);
  process.exit(1);
}
console.log(addresses.join(" "));
process.exit(0);
