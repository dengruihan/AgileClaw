/**
 * Receipt-id convention shared by the device-lease producer and the decision
 * writer. The producer emits `device-lease:<digest>` over its raw identity
 * tuple; the writer replaces that digest with the keyed audit projection
 * before the fact persists, so a low-entropy device id cannot be brute-forced
 * from the retained receipt id.
 */
export const DEVICE_LEASE_RECEIPT_ID_PREFIX = "device-lease:";

function isDeviceLeaseReceiptId(receiptId: string): boolean {
  return receiptId.startsWith(DEVICE_LEASE_RECEIPT_ID_PREFIX);
}

/**
 * The producer digest carried under the marker, or `undefined` for any other
 * owner's receipt id. Only the decision writer may call this; the digest never
 * persists unkeyed.
 */
export function deviceLeaseProducerDigest(receiptId: string): string | undefined {
  return isDeviceLeaseReceiptId(receiptId)
    ? receiptId.slice(DEVICE_LEASE_RECEIPT_ID_PREFIX.length)
    : undefined;
}
