// Built-in box layouts for the AREA forms Spencer uses, measured from the
// text layer of the blank PDFs (US Letter, 612 × 792 pt). The PDFs
// themselves are AREA members' material and are never stored in this
// repository: the agent uploads the blank, the footer code ("AREA©158CLDA")
// identifies the form, and the boxes below are placed on it. A later
// revision of a form keeps the same number, so the layout still applies;
// the revision string is compared so the editor can say "check the boxes".
//
// Positions are PDF points from the bottom-left, as pdf.js reports them.
// `blank()` turns a ruled line's baseline into a text box that sits on it;
// `sig()` is a signature box sitting on a signature line.

import type { FormTemplateField, FormFillField, FormSignField } from "@shared/schema";
import type { FieldType, SignerRole } from "./area-layouts-types";

export interface AreaLayout {
  /** The number in the footer code, e.g. "158". */
  id: string;
  name: string;
  kind: "purchase" | "amendment" | "listing" | "disclosure" | "other";
  /** The footer code of the revision these boxes were measured on. */
  measuredOn: string;
  pageCount: number;
  description: string;
  fields: () => FormTemplateField[];
}

const PAGE_W = 612;
const PAGE_H = 792;

type FillOpts = Partial<Pick<FormFillField, "dataType" | "align" | "fontSize" | "format" | "label">> & { h?: number };

class Builder {
  private n = 0;
  readonly out: FormTemplateField[] = [];

  private key(prefix: string) {
    this.n += 1;
    return `${prefix}${this.n}`;
  }

  /** A text box on a ruled line whose baseline is `yb`, spanning x0..x1. */
  blank(page: number, x0: number, x1: number, yb: number, name: string, opts: FillOpts = {}) {
    const h = opts.h ?? 14;
    const bottom = yb - 3;
    this.out.push({
      kind: "fill",
      key: this.key("f"),
      page,
      x: x0 / PAGE_W,
      y: (PAGE_H - (bottom + h)) / PAGE_H,
      w: (x1 - x0) / PAGE_W,
      h: h / PAGE_H,
      name,
      label: opts.label ?? null,
      dataType: opts.dataType ?? "text",
      align: opts.align ?? "left",
      fontSize: opts.fontSize ?? null,
      format: opts.format ?? null,
    });
    return this;
  }

  /** A paragraph box covering ruled lines from baseline `ybTop` (first line) to `ybBottom` (last line). */
  para(page: number, x0: number, x1: number, ybTop: number, ybBottom: number, name: string, opts: FillOpts = {}) {
    const top = ybTop + 10;
    const bottom = ybBottom - 3;
    this.out.push({
      kind: "fill",
      key: this.key("f"),
      page,
      x: x0 / PAGE_W,
      y: (PAGE_H - top) / PAGE_H,
      w: (x1 - x0) / PAGE_W,
      h: (top - bottom) / PAGE_H,
      name,
      label: opts.label ?? null,
      dataType: "multiline",
      align: "left",
      fontSize: opts.fontSize ?? 9,
      format: null,
    });
    return this;
  }

  /** A signature/initials/date/time box for a signer slot; `bottom` is the line it sits on. */
  sign(page: number, x0: number, x1: number, bottom: number, h: number, role: SignerRole, roleIndex: number, type: FieldType, format: string | null = null) {
    this.out.push({
      kind: "sign",
      key: this.key("s"),
      page,
      x: x0 / PAGE_W,
      y: (PAGE_H - (bottom + h)) / PAGE_H,
      w: (x1 - x0) / PAGE_W,
      h: h / PAGE_H,
      role,
      roleIndex,
      type,
      required: true,
      label: null,
      format,
    } as FormSignField);
    return this;
  }

  /** "Signed and dated at ____. m. on ____, 20___." for one signer: time, month-day, two-digit year. */
  signedAndDated(page: number, yb: number, role: SignerRole, roleIndex: number, x: { time: [number, number]; date: [number, number]; yy: [number, number] }) {
    const bottom = yb - 3;
    return this.sign(page, x.time[0], x.time[1], bottom, 13, role, roleIndex, "time", "ampm-short")
      .sign(page, x.date[0], x.date[1], bottom, 13, role, roleIndex, "date", "month-day")
      .sign(page, x.yy[0], x.yy[1], bottom, 13, role, roleIndex, "date", "yy");
  }
}

// Spans shared by every AREA form's "Signed and dated at ____. m. on ____, 20___." line.
const SIGNED_AT = { time: [124, 160] as [number, number], date: [191, 357] as [number, number], yy: [376, 407] as [number, number] };
const SIG_H = 18;

// ---- 158: Residential Purchase Contract -------------------------------------------

function residentialPurchaseContract(): FormTemplateField[] {
  const b = new Builder();
  const money = { dataType: "money" as const, format: "plain", align: "left" as const };
  const md = { dataType: "date" as const, format: "month-day" };
  const yy = { dataType: "date" as const, format: "yy", align: "center" as const };

  for (let p = 1; p <= 6; p++) b.blank(p, 478, 574, 748.3, "document.number", { h: 12, align: "center" });
  // Footer initials on pages 1–5: two sellers, two buyers.
  for (let p = 1; p <= 5; p++) {
    b.sign(p, 191, 235, 52, 12, "seller", 0, "initials")
      .sign(p, 244, 287, 52, 12, "seller", 1, "initials")
      .sign(p, 372, 415, 52, 12, "buyer", 0, "initials")
      .sign(p, 424, 468, 52, 12, "buyer", 1, "initials");
  }

  // Page 1 — parties and the property.
  b.blank(1, 66, 292, 668.4, "seller.1.name")
    .blank(1, 66, 292, 649.9, "seller.2.name")
    .blank(1, 347, 574, 668.4, "buyer.1.name")
    .blank(1, 347, 574, 649.9, "buyer.2.name")
    .blank(1, 168, 573, 589.3, "property.street")
    .blank(1, 85, 422, 569, "property.city")
    .blank(1, 468, 573, 569, "property.postal")
    .blank(1, 189, 263, 544.5, "property.legalPlan")
    .blank(1, 296, 375, 544.5, "property.legalBlock")
    .blank(1, 396, 465, 544.5, "property.legalLot")
    .blank(1, 499, 573, 544.5, "property.legalOther")
    .para(1, 186, 573, 528.2, 462.8, "offer.unattachedGoods")
    .para(1, 210, 573, 446.5, 430.2, "offer.attachedGoods")
    .blank(1, 170, 569, 403.4, "offer.price", money)
    .blank(1, 65, 445, 364.4, "offer.completionDay", md)
    .blank(1, 465, 495, 364.4, "offer.completionDay", yy);

  // Page 2 — deposits. The WEBForms export already prints "seller's" in
  // 3.1(m) and the payment choices (bank draft, wire transfer, direct
  // deposit) in the "method of payment" blanks, so nothing is placed there.
  b.blank(2, 188, 431, 618.3, "offer.depositHolder")
    .blank(2, 197, 367, 603.9, "offer.deposit", money)
    .blank(2, 349, 384, 589.7, "offer.depositDueTime", { align: "center" })
    .blank(2, 415, 515, 589.7, "offer.depositDueDate", md)
    .blank(2, 537, 562, 589.7, "offer.depositDueDate", yy)
    .blank(2, 245, 356, 565.3, "offer.additionalDeposit", money)
    .blank(2, 349, 384, 548.9, "offer.additionalDepositDueTime", { align: "center" })
    .blank(2, 415, 515, 548.9, "offer.additionalDepositDueDate", md)
    .blank(2, 537, 562, 548.9, "offer.additionalDepositDueDate", yy);

  // Page 3 — dower and conditions.
  b.blank(3, 85, 129, 613.4, "offer.dowerTime", { align: "center" })
    .blank(3, 160, 315, 613.4, "offer.dowerDate", md)
    .blank(3, 336, 371, 613.4, "offer.dowerDate", yy)
    .blank(3, 505, 543, 467.9, "offer.downPaymentPercent", { align: "center" })
    .blank(3, 93, 210, 443.1, "offer.financingConditionDay", md)
    .blank(3, 228, 256, 443.1, "offer.financingConditionDay", yy)
    .blank(3, 150, 288, 391, "offer.inspectionConditionDay", md)
    .blank(3, 306, 337, 391, "offer.inspectionConditionDay", yy)
    .blank(3, 348, 381, 351.3, "offer.saleConditionTime", { align: "center" })
    .blank(3, 412, 571, 351.3, "offer.saleConditionDay", md)
    .blank(3, 94, 123, 338.8, "offer.saleConditionDay", yy)
    .para(3, 86, 573, 309.8, 266.8, "offer.buyerConditions")
    .blank(3, 115, 151, 252.4, "offer.buyerConditionsTime", { align: "center" })
    .blank(3, 181, 350, 252.4, "offer.buyerConditionsDay", md)
    .blank(3, 369, 400, 252.4, "offer.buyerConditionsDay", yy)
    .para(3, 66, 573, 213.3, 165.6, "offer.sellerConditions")
    .blank(3, 96, 131, 149.7, "offer.sellerConditionsTime", { align: "center" })
    .blank(3, 162, 331, 149.7, "offer.sellerConditionsDay", md)
    .blank(3, 350, 381, 149.7, "offer.sellerConditionsDay", yy);

  // Page 4 — attachments. (9.2 "Other terms" is left alone: the blank
  // exported from WEBForms already carries the agent's standard clauses.)
  b.blank(4, 106, 573, 623.5, "offer.otherAttachment");

  // Page 5 — brokerages and the confirmation initials.
  b.blank(5, 89, 306, 443, "listing.brokerage")
    .blank(5, 105, 306, 426.7, "listing.brokerageAddress")
    .blank(5, 89, 306, 377.6, "listing.agent")
    .blank(5, 96, 305, 361.2, "listing.agentPhone")
    .blank(5, 95, 306, 328.5, "listing.agentEmail")
    .blank(5, 352, 573, 443, "agent.brokerage")
    .para(5, 366, 573, 426.7, 410.2, "agent.address", { fontSize: 8 })
    .blank(5, 352, 573, 377.6, "agent.name")
    .blank(5, 354, 573, 361.2, "agent.phone")
    .blank(5, 356, 573, 328.5, "agent.email")
    .sign(5, 132, 192, 123, 12, "seller", 0, "initials")
    .sign(5, 199, 259, 123, 12, "seller", 1, "initials")
    .sign(5, 442, 504, 123, 12, "buyer", 0, "initials")
    .sign(5, 510, 573, 123, 12, "buyer", 1, "initials");

  // Page 6 — offer, acceptance, conveyancing.
  b.blank(6, 77, 519, 679.4, "offer.openUntilDate", md)
    .blank(6, 538, 569, 679.4, "offer.openUntilDate", yy)
    .signedAndDated(6, 653, "buyer", 0, SIGNED_AT)
    .sign(6, 36, 205, 635, SIG_H, "buyer", 0, "signature")
    .signedAndDated(6, 605.7, "buyer", 1, SIGNED_AT)
    .sign(6, 36, 205, 588, SIG_H, "buyer", 1, "signature")
    .signedAndDated(6, 523.7, "seller", 0, SIGNED_AT)
    .sign(6, 36, 205, 506, SIG_H, "seller", 0, "signature")
    .signedAndDated(6, 474.5, "seller", 1, SIGNED_AT)
    .sign(6, 36, 205, 457, SIG_H, "seller", 1, "signature")
    .blank(6, 75, 295, 207.9, "seller.1.address")
    .blank(6, 66, 159, 175.2, "seller.1.phone")
    .blank(6, 94, 295, 158.9, "conveyancing.sellerLawyer")
    .blank(6, 79, 295, 142.5, "conveyancing.sellerLawyerFirm")
    .blank(6, 93, 295, 126.1, "conveyancing.sellerLawyerAddress")
    .blank(6, 81, 164, 93.5, "conveyancing.sellerLawyerPhone")
    .blank(6, 83, 295, 77.1, "conveyancing.sellerLawyerEmail")
    .blank(6, 352, 573, 207.9, "buyer.1.address")
    .blank(6, 343, 445, 175.2, "buyer.1.phone")
    .blank(6, 371, 573, 158.9, "conveyancing.buyerLawyer")
    .blank(6, 356, 573, 142.5, "conveyancing.buyerLawyerFirm")
    .blank(6, 370, 573, 126.1, "conveyancing.buyerLawyerAddress")
    .blank(6, 358, 446, 93.5, "conveyancing.buyerLawyerPhone")
    .blank(6, 361, 573, 77.1, "conveyancing.buyerLawyerEmail");

  return b.out;
}

// ---- 157: Residential Resale Condominium Property Purchase Contract ---------------------

function condoPurchaseContract(): FormTemplateField[] {
  const b = new Builder();
  const money = { dataType: "money" as const, format: "plain", align: "left" as const };
  const md = { dataType: "date" as const, format: "month-day" };
  const yy = { dataType: "date" as const, format: "yy", align: "center" as const };
  const time = { align: "center" as const };
  // Typed on the review screen; no deal data behind them.
  const typed = (label: string) => ({ label });

  for (let p = 1; p <= 8; p++) b.blank(p, 476, 576, 748.3, "document.number", { h: 12, align: "center" });
  // Footer initials on pages 1–6: two sellers, two buyers.
  for (let p = 1; p <= 6; p++) {
    b.sign(p, 191, 235, 52, 12, "seller", 0, "initials")
      .sign(p, 244, 287, 52, 12, "seller", 1, "initials")
      .sign(p, 372, 415, 52, 12, "buyer", 0, "initials")
      .sign(p, 424, 468, 52, 12, "buyer", 1, "initials");
  }

  // Page 1 — parties, the unit, goods, price.
  b.blank(1, 66, 292, 668.4, "seller.1.name")
    .blank(1, 66, 292, 649.9, "seller.2.name")
    .blank(1, 347, 574, 668.4, "buyer.1.name")
    .blank(1, 347, 574, 649.9, "buyer.2.name")
    .blank(1, 166, 575, 589.3, "property.street")
    .blank(1, 83, 424, 569, "property.city")
    .blank(1, 466, 575, 569, "property.postal")
    .blank(1, 144, 575, 544.6, "property.projectName")
    // Legal description of titled units: residential, parking, storage.
    .blank(1, 235, 351, 513.5, "property.legalPlan")
    .blank(1, 378, 459, 513.5, "property.legalUnit")
    .blank(1, 517, 573, 513.5, "property.unitFactor")
    .blank(1, 235, 351, 498.5, "custom.parking-plan", typed("Parking unit — condominium plan"))
    .blank(1, 388, 459, 498.5, "custom.parking-units", typed("Parking unit(s)"))
    .blank(1, 521, 573, 498.5, "custom.parking-unit-factor", typed("Parking unit factor(s)"))
    .blank(1, 235, 351, 483.5, "custom.storage-plan", typed("Storage unit — condominium plan"))
    .blank(1, 388, 459, 483.5, "custom.storage-units", typed("Storage unit(s)"))
    .blank(1, 521, 573, 483.5, "custom.storage-unit-factor", typed("Storage unit factor(s)"))
    // Non-titled, assigned or leased areas.
    .blank(1, 189, 288, 452, "custom.stalls-assigned", typed("Parking stalls assigned"))
    .blank(1, 353, 436, 452, "custom.stalls-leased", typed("Parking stalls leased"))
    .blank(1, 503, 573, 452, "custom.stall-numbers", typed("Stall numbers"))
    .blank(1, 197, 288, 436.5, "custom.storage-assigned", typed("Storage spaces assigned"))
    .blank(1, 359, 436, 436.5, "custom.storage-leased", typed("Storage spaces leased"))
    .blank(1, 511, 573, 436.5, "custom.storage-numbers", typed("Storage space numbers"))
    .para(1, 86, 575, 403.4, 370.8, "offer.unattachedGoods")
    .para(1, 208, 575, 354.5, 338, "offer.attachedGoods")
    .blank(1, 168, 569, 311.3, "offer.price", money)
    .blank(1, 63, 447, 272.3, "offer.completionDay", md)
    .blank(1, 462, 497, 272.3, "offer.completionDay", yy);

  // Page 2 — who sends the contract to the lawyers, deposits.
  b.blank(2, 96, 327, 440.5, "offer.contractProvidedBy", { align: "center" })
    .blank(2, 186, 433, 386, "offer.depositHolder")
    .blank(2, 195, 369, 371.6, "offer.deposit", money)
    .blank(2, 109, 300, 357.4, "offer.depositMethod")
    .blank(2, 358, 398, 357.4, "offer.depositDueTime", time)
    .blank(2, 424, 527, 357.4, "offer.depositDueDate", md)
    .blank(2, 544, 573, 357.4, "offer.depositDueDate", yy)
    .blank(2, 243, 358, 337.9, "offer.additionalDeposit", money)
    .blank(2, 109, 300, 323.6, "offer.additionalDepositMethod")
    .blank(2, 358, 398, 323.6, "offer.additionalDepositDueTime", time)
    .blank(2, 424, 527, 323.6, "offer.additionalDepositDueDate", md)
    .blank(2, 544, 573, 323.6, "offer.additionalDepositDueDate", yy);

  // Page 3 — dower, condominium documents.
  b.blank(3, 112, 161, 409.4, "offer.dowerTime", time)
    .blank(3, 187, 346, 409.4, "offer.dowerDate", md)
    .blank(3, 363, 402, 409.4, "offer.dowerDate", yy)
    .blank(3, 460, 497, 253.6, "offer.condoDocsConditionTime", time)
    .blank(3, 109, 237, 243.2, "offer.condoDocsConditionDay", md)
    .blank(3, 252, 287, 243.2, "offer.condoDocsConditionDay", yy)
    .blank(3, 531, 567, 220.3, "offer.condoDocsDeliveryTime", time)
    .blank(3, 119, 249, 210, "offer.condoDocsDeliveryDay", md)
    .blank(3, 264, 299, 210, "offer.condoDocsDeliveryDay", yy)
    .blank(3, 382, 420, 164, "custom.condo-docs-extended-time", { ...time, label: "Condo documents late — Condition Day extends to (time)" })
    .blank(3, 444, 568, 164, "custom.condo-docs-extended-day", { label: "Condo documents late — Condition Day extends to (date)" })
    .blank(3, 109, 144, 153.7, "custom.condo-docs-extended-yy", { align: "center", label: "Condo documents late — year (two digits)" });

  // Page 4 — other documents, financing, inspection, sale of buyer's property, buyer's conditions.
  b.para(4, 144, 575, 359.4, 335.6, "custom.condo-docs-other", typed("Other condominium documents requested"))
    .blank(4, 499, 541, 311.1, "offer.downPaymentPercent", time)
    .blank(4, 484, 521, 298.8, "offer.financingConditionTime", time)
    .blank(4, 83, 191, 286.4, "offer.financingConditionDay", md)
    .blank(4, 205, 238, 286.4, "offer.financingConditionDay", yy)
    .blank(4, 112, 151, 235.1, "offer.inspectionConditionTime", time)
    .blank(4, 177, 316, 235.1, "offer.inspectionConditionDay", md)
    .blank(4, 331, 365, 235.1, "offer.inspectionConditionDay", yy)
    .blank(4, 357, 395, 196.1, "offer.saleConditionTime", time)
    .blank(4, 420, 571, 196.1, "offer.saleConditionDay", md)
    .blank(4, 92, 125, 183.7, "offer.saleConditionDay", yy)
    .para(4, 86, 575, 156.9, 118.8, "offer.buyerConditions")
    .blank(4, 113, 153, 93.2, "offer.buyerConditionsTime", time)
    .blank(4, 179, 353, 93.2, "offer.buyerConditionsDay", md)
    .blank(4, 368, 402, 93.2, "offer.buyerConditionsDay", yy);

  // Page 5 — seller's conditions, attachments, condo fees, other terms.
  b.para(5, 66, 575, 697.9, 697.9, "offer.sellerConditions")
    .blank(5, 94, 133, 682.1, "offer.sellerConditionsTime", time)
    .blank(5, 160, 333, 682.1, "offer.sellerConditionsDay", md)
    .blank(5, 348, 383, 682.1, "offer.sellerConditionsDay", yy)
    .blank(5, 104, 575, 513, "offer.otherAttachment")
    .blank(5, 384, 575, 472, "property.condoFee", money)
    .blank(5, 397, 575, 455.6, "custom.non-titled-fee", typed("Monthly fee for non-titled, assigned or leased areas"))
    .para(5, 66, 575, 425.4, 393.6, "offer.additionalTerms");

  // Pages 6–7 — authorization: the seller's side is the listing brokerage,
  // the buyer's side is Spencer's.
  b.blank(6, 87, 307, 133.8, "listing.brokerage")
    .blank(6, 103, 307, 117.5, "listing.brokerageAddress")
    .blank(6, 350, 575, 133.8, "agent.brokerage")
    .blank(6, 364, 575, 117.5, "agent.address", { fontSize: 8 });
  b.blank(7, 87, 307, 704.4, "listing.agent")
    .blank(7, 94, 307, 688, "listing.agentPhone")
    .blank(7, 93, 307, 655.3, "listing.agentEmail")
    .blank(7, 350, 575, 704.4, "agent.name")
    .blank(7, 352, 575, 688, "agent.phone")
    .blank(7, 354, 575, 655.3, "agent.email")
    .sign(7, 130, 195, 433, 12, "seller", 0, "initials")
    .sign(7, 197, 262, 433, 12, "seller", 1, "initials")
    .sign(7, 440, 506, 433, 12, "buyer", 0, "initials")
    .sign(7, 508, 575, 433, 12, "buyer", 1, "initials")
    // 17.2 "open for written acceptance until ____ ____. m. on ____, 20__."
    .blank(7, 527, 564, 360, "offer.openUntilTime", time)
    .blank(7, 75, 521, 345.4, "offer.openUntilDate", md)
    .blank(7, 536, 571, 345.4, "offer.openUntilDate", yy)
    .signedAndDated(7, 319.1, "buyer", 0, SIGNED_AT)
    .sign(7, 36, 205, 301, SIG_H, "buyer", 0, "signature")
    .signedAndDated(7, 271.8, "buyer", 1, SIGNED_AT)
    .sign(7, 36, 205, 254, SIG_H, "buyer", 1, "signature")
    .signedAndDated(7, 189.8, "seller", 0, SIGNED_AT)
    .sign(7, 36, 205, 172, SIG_H, "seller", 0, "signature")
    .signedAndDated(7, 140.6, "seller", 1, SIGNED_AT)
    .sign(7, 36, 205, 123, SIG_H, "seller", 1, "signature");

  // Page 8 — conveyancing information.
  b.blank(8, 73, 297, 493.1, "seller.1.address")
    .blank(8, 64, 161, 460.3, "seller.1.phone")
    .blank(8, 63, 297, 444, "seller.1.email")
    .blank(8, 92, 297, 427.7, "conveyancing.sellerLawyer")
    .blank(8, 77, 297, 411.4, "conveyancing.sellerLawyerFirm")
    .blank(8, 91, 297, 394.9, "conveyancing.sellerLawyerAddress")
    .blank(8, 79, 166, 362.3, "conveyancing.sellerLawyerPhone")
    .blank(8, 81, 297, 346, "conveyancing.sellerLawyerEmail")
    .blank(8, 350, 575, 493.1, "buyer.1.address")
    .blank(8, 341, 447, 460.3, "buyer.1.phone")
    .blank(8, 340, 575, 444, "buyer.1.email")
    .blank(8, 369, 575, 427.7, "conveyancing.buyerLawyer")
    .blank(8, 354, 575, 411.4, "conveyancing.buyerLawyerFirm")
    .blank(8, 368, 575, 394.9, "conveyancing.buyerLawyerAddress")
    .blank(8, 356, 447, 362.3, "conveyancing.buyerLawyerPhone")
    .blank(8, 359, 575, 346, "conveyancing.buyerLawyerEmail");

  return b.out;
}

// ---- 160 / 159 / 163: the one-page contract riders ---------------------------------------

function riderHeader(b: Builder, addressYb: number) {
  b.blank(1, 354, 424, 690.1, "document.number", { h: 11, align: "center", fontSize: 7 })
    .blank(1, 66, 292, 666.4, "seller.1.name")
    .blank(1, 66, 292, 647.9, "seller.2.name")
    .blank(1, 347, 573, 666.4, "buyer.1.name")
    .blank(1, 347, 573, 647.9, "buyer.2.name")
    .blank(1, 122, 573, addressYb, "property.address");
}

function amendment(): FormTemplateField[] {
  const b = new Builder();
  riderHeader(b, 626.5);
  b.para(1, 70, 572, 573.1, 461.8, "amendment.delete")
    .para(1, 73, 572, 445.8, 334.6, "amendment.insert")
    .signedAndDated(1, 282.1, "buyer", 0, SIGNED_AT)
    .sign(1, 36, 205, 262, SIG_H, "buyer", 0, "signature")
    .signedAndDated(1, 229.4, "buyer", 1, SIGNED_AT)
    .sign(1, 36, 205, 209, SIG_H, "buyer", 1, "signature")
    .signedAndDated(1, 161.4, "seller", 0, SIGNED_AT)
    .sign(1, 36, 205, 141, SIG_H, "seller", 0, "signature")
    .signedAndDated(1, 108.7, "seller", 1, SIGNED_AT)
    .sign(1, 36, 205, 88, SIG_H, "seller", 1, "signature");
  return b.out;
}

function addendum(): FormTemplateField[] {
  const b = new Builder();
  riderHeader(b, 626.5);
  const datedAt = { time: [77, 113] as [number, number], date: [144, 310] as [number, number], yy: [330, 361] as [number, number] };
  b.para(1, 42, 572, 573.1, 286.8, "addendum.terms")
    // One "Dated at" line covers both buyers, then one for both sellers.
    .signedAndDated(1, 247.1, "buyer", 0, datedAt)
    .sign(1, 36, 205, 227, SIG_H, "buyer", 0, "signature")
    .sign(1, 36, 205, 198, SIG_H, "buyer", 1, "signature")
    .signedAndDated(1, 150.1, "seller", 0, datedAt)
    .sign(1, 36, 205, 130, SIG_H, "seller", 0, "signature")
    .sign(1, 36, 205, 101, SIG_H, "seller", 1, "signature");
  return b.out;
}

function notice(): FormTemplateField[] {
  const b = new Builder();
  riderHeader(b, 624.8);
  // The party waiving is usually the buyer; the slot can be changed in the editor.
  b.blank(1, 63, 181, 565, "notice.party", { align: "center" })
    .para(1, 42, 572, 546.5, 381, "notice.conditions")
    .signedAndDated(1, 323.3, "buyer", 0, SIGNED_AT)
    .sign(1, 36, 205, 297, SIG_H, "buyer", 0, "signature")
    .signedAndDated(1, 248, "buyer", 1, SIGNED_AT)
    .sign(1, 36, 205, 222, SIG_H, "buyer", 1, "signature");
  return b.out;
}

// ---- 123: Exclusive Buyer Representation Agreement -----------------------------------------

function buyerRepresentation(): FormTemplateField[] {
  const b = new Builder();
  const md = { dataType: "date" as const, format: "month-day" };
  const yy = { dataType: "date" as const, format: "yy", align: "center" as const };
  for (let p = 1; p <= 4; p++) b.blank(p, 483, 579, 748.3, "document.number", { h: 12, align: "center" });
  for (let p = 1; p <= 3; p++) {
    b.sign(p, 192, 235, 52, 12, "buyer", 0, "initials").sign(p, 244, 288, 52, 12, "buyer", 1, "initials").sign(p, 403, 447, 52, 12, "agent", 0, "initials");
  }
  b.blank(1, 66, 292, 646.7, "agent.brokerage")
    .blank(1, 347, 573, 646.7, "buyer.1.name")
    .blank(1, 347, 573, 628.2, "buyer.2.name")
    .blank(1, 175, 469, 446.4, "agreement.startDate", md)
    .blank(1, 488, 504, 446.4, "agreement.startDate", yy)
    .blank(1, 523, 558, 446.4, "agreement.startTime", { align: "center" })
    .blank(1, 111, 400, 434.5, "agreement.endDate", md)
    .blank(1, 419, 435, 434.5, "agreement.endDate", yy)
    .blank(1, 453, 489, 434.5, "agreement.endTime", { align: "center" });
  b.blank(4, 59, 285, 698.4, "buyer.1.name")
    .blank(4, 349, 573, 698.4, "buyer.2.name")
    .blank(4, 75, 285, 679.9, "buyer.1.address")
    .blank(4, 360, 573, 679.9, "buyer.2.address")
    .blank(4, 66, 158, 660.7, "buyer.1.phone")
    .blank(4, 354, 446, 660.7, "buyer.2.phone")
    .blank(4, 62, 285, 644.4, "buyer.1.email")
    .blank(4, 350, 573, 644.4, "buyer.2.email")
    .blank(4, 59, 285, 593.3, "agent.brokerage")
    .blank(4, 75, 285, 575, "agent.address", { fontSize: 7 })
    .blank(4, 66, 158, 555.7, "agent.phone")
    .blank(4, 62, 285, 537.4, "agent.email")
    .blank(4, 349, 573, 593.3, "agent.name")
    .blank(4, 354, 446, 555.7, "agent.phone")
    .blank(4, 353, 572, 537.4, "agent.email")
    .sign(4, 144, 528, 407.5, 13, "buyer", 0, "date", "month-day")
    .sign(4, 550, 571, 407.5, 13, "buyer", 0, "date", "yy")
    .sign(4, 36, 290, 378, 22, "buyer", 0, "signature")
    .sign(4, 315, 573, 378, 22, "buyer", 1, "signature")
    .blank(4, 36, 290, 352, "buyer.1.name", { h: 13 })
    .blank(4, 315, 573, 352, "buyer.2.name", { h: 13 })
    .sign(4, 36, 290, 242, 22, "agent", 0, "signature")
    .blank(4, 315, 573, 244, "agent.name", { h: 13 });
  return b.out;
}

export const AREA_LAYOUTS: AreaLayout[] = [
  {
    id: "158",
    name: "Residential Purchase Contract",
    kind: "purchase",
    measuredOn: "AREA©158CLDA_JAN2026",
    pageCount: 6,
    description: "Parties, property, price, deposits, conditions, brokerages and conveyancing filled from the deal; signature, date and initials boxes for two buyers and two sellers.",
    fields: residentialPurchaseContract,
  },
  {
    id: "157",
    name: "Residential Resale Condominium Property Purchase Contract",
    kind: "purchase",
    measuredOn: "AREA©157CLDA_MAR2026",
    pageCount: 8,
    description: "Parties, the unit and its legal description, condo fee, price, deposits, conditions, brokerages and conveyancing filled from the deal; signature, date and initials boxes for two buyers and two sellers.",
    fields: condoPurchaseContract,
  },
  {
    id: "160",
    name: "Amendment",
    kind: "amendment",
    measuredOn: "AREA©160CLDARoot_JUL2025",
    pageCount: 1,
    description: "Contract number, parties and address filled from the deal; delete/insert paragraphs typed; signatures for two buyers and two sellers.",
    fields: amendment,
  },
  {
    id: "159",
    name: "Addendum",
    kind: "amendment",
    measuredOn: "AREA©159CLDARoot_2017May",
    pageCount: 1,
    description: "Contract number, parties and address filled from the deal; additional terms typed; signatures for two buyers and two sellers.",
    fields: addendum,
  },
  {
    id: "163",
    name: "Notice (waiver / satisfaction of conditions)",
    kind: "amendment",
    measuredOn: "AREA©163CLDARoot_JUL2025",
    pageCount: 1,
    description: "Contract number, parties and address filled from the deal; the conditions typed; signature boxes for the buyers (change the slot to seller when the seller is waiving).",
    fields: notice,
  },
  {
    id: "123",
    name: "Exclusive Buyer Representation Agreement",
    kind: "other",
    measuredOn: "AREA©123DARoot_JUL2025",
    pageCount: 4,
    description: "Buyer and brokerage details filled from the deal; term dates typed; signatures and initials for two buyers and the agent.",
    fields: buyerRepresentation,
  },
];

export function findAreaLayout(id: string): AreaLayout | undefined {
  return AREA_LAYOUTS.find((l) => l.id === id);
}
