// The morning-after flow, at a desk: the forgotten session goes in from the
// keyboard, and the week, the streak and the shape all take it in; Undo takes
// it out again (so the service is left as it was found).

const read = (drive, path, attr) =>
  drive.page.evaluate((p, a) => { const v = window.__declare.find(p)[a]; return v === undefined ? null : v }, path, attr);

export default async ({ drive, expect }) => {
  try { await flow({ drive, expect }); }
  finally {
    // whatever happened, take back anything this run added
    await drive.page.evaluate(() => {
      const s = window.__declare.find("app.sessions");
      const id = window.__declare.find("app").lastAdded;
      if (id && s.byId(id)) s.remove(id);
      return null;
    });
    await drive.settleData();
  }
};

const flow = async ({ drive, expect }) => {
  await drive.settleData();
  await drive.settleMotion();
  const count0 = await read(drive, "app", "weekCount");
  const mins0 = await read(drive, "app", "weekMinutes");
  const streak0 = await read(drive, "app", "streak");
  await expect.text("app.main.today.thisWeek.line.count", String(count0));

  // N opens the form; three days back is Sunday, which was empty
  await drive.key("n");
  await drive.settleMotion();
  await expect.visible("app.form");
  await drive.key("ArrowLeft");
  await drive.key("ArrowLeft");
  await drive.key("ArrowLeft");
  await drive.key("b");
  await drive.key("ArrowUp");
  await drive.key("8");
  await drive.settleMotion();
  await expect.attr("app.form.entry", "sport", "ride");
  await expect.attr("app.form.entry", "effort", 8);
  await expect.attr("app.form.entry", "day", (await read(drive, "app", "todayN")) - 3);

  await drive.click("app.form.entry.save");
  await drive.settleData();
  await drive.settleMotion();
  await expect.request("POST", "/api/sessions", { body: { sport: "ride", effort: 8 } });
  await expect.attr("app", "formOpen", false);
  await expect.attr("app", "weekCount", count0 + 1);
  await expect.approx("app", "weekCountShown", count0 + 1, 0.01);
  const mins1 = await read(drive, "app", "weekMinutes");
  if (!(mins1 > mins0)) throw new Error(`week minutes did not grow: ${mins0} → ${mins1}`);
  const streak1 = await read(drive, "app", "streak");
  if (!(streak1 > streak0)) throw new Error(`streak did not grow: ${streak0} → ${streak1}`);
  await expect.text("app.main.today.thisWeek.line.count", String(count0 + 1));

  // Undo on the toast deletes it again
  await drive.click("app.toast.Undo");
  await drive.settleData();
  await drive.settleMotion();
  await expect.request("DELETE", "/api/sessions/");
  await expect.attr("app", "weekCount", count0);
  await expect.attr("app", "streak", streak0);

  // Standing in the gym, on a phone: two taps — the button, then Save. The
  // form already holds today, the usual sport for the weekday, and the usual
  // length, distance and effort for it.
  await drive.device({ width: 390, height: 844, touch: true });
  await drive.settleData();
  await drive.settleMotion();
  await drive.click("app.logPhone");
  await drive.settleMotion();
  await expect.attr("app.form.entry", "day", await read(drive, "app", "todayN"));
  await drive.click("app.form.entry.save");
  await drive.settleData();
  await drive.settleMotion();
  await expect.attr("app", "formOpen", false);
  await expect.attr("app", "weekCount", count0 + 1);
  await expect.attr("app", "streak", streak0 + 1);
  await expect.text("app.main.today.streak.line.days", String(streak0 + 1));
  await drive.click("app.toast.Undo");
  await drive.settleData();
  await expect.attr("app", "weekCount", count0);
};
