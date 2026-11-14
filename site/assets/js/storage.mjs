/** Pure yocto math for a full escrow withdrawal. No browser globals. */

import { asBig, yoctoToNear } from "./format.mjs";

/** Protocol storage price: 10^19 yoctoNEAR per byte. */
export const STORAGE_BYTE_YOCTO = 10n ** 19n;

/** 0.001 NEAR. The plain-transfer top-up is rounded up to this step. */
export const TOP_UP_STEP_YOCTO = 10n ** 21n;

/**
 * slack = amount - storage_usage * 10^19 - escrow.
 * When slack is negative, topUp is -slack plus 0.001 NEAR, rounded up to 0.001 NEAR.
 * An exact multiple of 0.001 stays as it is. Zero and positive slack need no top-up.
 */
export function withdrawalSlack({ amount, storageUsage, escrow } = {}) {
  const balance = asBig(amount);
  const usage = asBig(storageUsage);
  const held = asBig(escrow);
  if (balance < 0n || usage < 0n || held < 0n) throw new Error("storage slack inputs must be >= 0");
  const slack = balance - usage * STORAGE_BYTE_YOCTO - held;
  if (slack >= 0n) return { slack, blocked: false, topUpYocto: 0n, topUpNear: "0" };
  const raw = -slack + TOP_UP_STEP_YOCTO;
  const topUpYocto = ((raw + TOP_UP_STEP_YOCTO - 1n) / TOP_UP_STEP_YOCTO) * TOP_UP_STEP_YOCTO;
  return { slack, blocked: true, topUpYocto, topUpNear: yoctoToNear(topUpYocto) };
}
