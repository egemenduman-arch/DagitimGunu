import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDays, trKey, timingSafeEqual } from "../worker.js";

// Gün dizisi sırası: [Pzt, Sal, Çar, Per, Cum, Cmt, Paz]

test("trKey: Türkçe karakterleri ve mahalle eklerini normalleştirir", () => {
  assert.equal(trKey("İSTİKLAL Mahallesi"), "istiklal");
  assert.equal(trKey("Çamlıca Mah."), "camlica");
  assert.equal(trKey("Gökçeören Köyü"), "gokceoren");
  assert.equal(trKey("Şişli / Ölçek  Mh."), "sisli olcek");
});

test("extractDays: .NET DayOfWeek (0=Pazar)", () => {
  assert.deepEqual(extractDays([1, 4]), [1, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual(extractDays([0, 6]), [0, 0, 0, 0, 0, 1, 1]);
});

test("extractDays: ISO (7=Pazar) listesi algılanır", () => {
  assert.deepEqual(extractDays([1, 7]), [1, 0, 0, 0, 0, 0, 1]);
});

test("extractDays: gün adları ve nesne biçimleri", () => {
  assert.deepEqual(extractDays(["Monday", "Cuma"]), [1, 0, 0, 0, 1, 0, 0]);
  assert.deepEqual(
    extractDays({ monday: true, tuesday: false, wednesday: 1, thursday: 0, friday: "evet", saturday: false, sunday: false }),
    [1, 0, 1, 0, 1, 0, 0]
  );
  assert.deepEqual(
    extractDays([{ dayOfWeek: 1, isActive: true }, { dayOfWeek: 2, isActive: false }]),
    [1, 0, 0, 0, 0, 0, 0]
  );
  assert.deepEqual(extractDays({ result: { workDays: ["Salı"] } }), [0, 1, 0, 0, 0, 0, 0]);
});

test("extractDays: boş ve çözümlenemeyen girdiler", () => {
  assert.deepEqual(extractDays([]), [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(extractDays(null), null);
  assert.equal(extractDays("bilinmiyor"), null);
});

test("timingSafeEqual", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("", ""), true);
});
