/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import test from "node:test";
import { inIvaServiceCgroup } from "./service-context.ts";

test("identifies children of iva.service without matching other units", () => {
  assert.equal(
    inIvaServiceCgroup(
      () =>
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/iva.service\n",
    ),
    true,
  );
  assert.equal(
    inIvaServiceCgroup(
      () =>
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/iva-bitrix24-update-123.service\n",
    ),
    false,
  );
  assert.equal(
    inIvaServiceCgroup(() => "0::/system.slice/my-iva.service\n"),
    false,
  );
  assert.equal(
    inIvaServiceCgroup(() => "10:memory:/user.slice/iva.service/subgroup\n"),
    true,
  );
  assert.equal(
    inIvaServiceCgroup(() => {
      throw new Error("no procfs");
    }),
    false,
  );
});
