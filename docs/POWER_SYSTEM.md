# CritterWatch Power System — Decisions & Build Guide

**Status:** Decided (July 2026)
**Applies to:** All 20 camera nodes (creek corridor + planned coastal/marine sites)
**Audience:** Any Louie Labs member wiring, testing, or deploying a node. Read the whole thing before touching a battery.

---

## 1. What we decided and why

| Part | Decision | Why |
|---|---|---|
| Solar charge controller | **LiFePO4wered/Solar1** (CN3801-based, from Silicognition on Tindie) | Purpose-built for 1S LiFePO4 solar IoT. Buck MPPT charger, 4.5–28V input, up to 3A, settable MPP voltage, built-in low-voltage disconnect (LVD), temperature lockout, and optional battery heater drive. |
| Battery | **32700 LiFePO4 cell** (bare/unprotected, ~6Ah, 3.2V nominal, ~19Wh) | Cheapest $/Wh of any US-available LFP format. One cell = no paralleling. Standardizing all 20 nodes on one holder simplifies spares. |
| Solar array | **3× 2W panels in parallel** (must be 6V-class: Vmp ≈ 6V, Voc ≈ 7–7.5V) | ~6W peak, ~1A at Vmp. Parallel wiring avoids the partial-shade problems of series strings — important under tree canopy. |
| Telemetry | **2× TI INA228** current/voltage/power monitors | 20-bit resolution allows tiny shunts; hardware charge/energy accumulation registers solve our sparse-sampling problem (see §5). |

Rejected alternatives, for the record: **CN3791** boards are everywhere and cheap but charge to 4.2V — Li-ion only, cannot be modified for LiFePO4 and will trip the cell's protection every cycle. **BQ24650** generic boards are preconfigured for 12V panels / 3S–4S packs and need resistor rework on three dividers (the Voltaic Systems board with rotary switches is the one off-the-shelf exception). **LTC4015** is the best chip (true MPPT sweep, coulomb counter, I2C) but has no cheap modules — eval board is ~$150+, a non-starter at 20 nodes. Fixed-setpoint "MPPT" like the CN3801's gives up very little vs. true MPPT here: a panel's max-power voltage barely moves with light level (it moves with temperature), and dappled light mostly changes current, which a constant-voltage input loop tracks fine.

---

## 2. Battery: rules that keep everyone safe

The 32700 is a **bare cell** — no protection PCB inside the wrapper. That is intentional: the Solar1 board provides all three protections (3.6V charge ceiling, under/over-temperature charge lockout, 2.7V low-voltage load disconnect). But the protection only works if the topology is respected. These rules are non-negotiable:

1. **The load ALWAYS connects to the Solar1's VOUT terminals — never directly to the battery.** The LVD sits between the battery and VOUT. Wiring the camera node straight to the cell "just for testing" bypasses the only over-discharge protection in the system. An ESP32 brownout-looping on a dying cell will drag it below 2.0V and permanently damage it.
2. **Fuse at the cell.** A 2–3A fuse or polyfuse goes directly at the cell's + terminal, before anything else. LiFePO4 won't fireball like Li-ion cobalt chemistries, but a shorted 32700 will melt insulation and glow wire red-hot. Keep battery-to-board leads short.
3. **Spare cells get respect.** Terminals taped, stored in individual cases, never loose in a box with tools, keys, or other cells.
4. **Bench charging = LiFePO4 charger ONLY (3.6V termination).** A standard Li-ion charger terminates at 4.2V and will overcharge the cell with nothing in the loop to stop it. Label the charging station. If a node comes back with a flat battery, it goes on the LFP charger or back on a Solar1 — nothing else.
5. When buying cells, search for the **IFR** prefix (IFR32700) — that's the LiFePO4 chemistry code. The same sizes exist in 3.7V Li-ion; do not mix them up. Verify the cell's max charge current on its datasheet: our worst-case solar charge is ~1.5A, which any 1C-rated (6A) or even 0.5C-rated cell handles.

**Size gotcha:** a 32700 is D-cell diameter (32 vs 33mm) but 70mm long vs a D's 61.5mm. **It will not fit a D-cell holder.** Buy holders specifically sold as 32650/32700. For enclosure CAD: model it as a D cell plus ~8.5mm of length plus the holder flange. Weight ≈ 140–145g.

Battery facts worth knowing: ~19Wh per cell with a very flat discharge curve, a couple thousand cycles, discharge is fine well below freezing — only **charging** below 0°C is prohibited (the Solar1 enforces this automatically).

---

## 3. Solar array: verify, then configure

**Before wiring anything, verify the panels are 6V-class.** Check the label or measure open-circuit voltage in full sun: you want Voc ≈ 7–7.5V, Vmp ≈ 6V. The Solar1 is a buck charger with a 4.5V input floor and needs input comfortably above the 3.6V battery charge voltage. 5V-class panels work but with thin margin; anything lower (2-cell/3V panels, bare cells) cannot work in parallel — that would need series wiring and a redesign.

Wire the three panels in parallel at a single combiner point. **No blocking diodes between panels** — with identical panels, a shaded panel's voltage drops only slightly, so it just contributes less current rather than sinking meaningful reverse current. A diode per panel would cost ~0.3V (≈5% of harvest) for nothing.

Two resistors to set on the Solar1 (see the LiFePO4wered/Solar1 product docs for values):

- **MPP voltage** → set to the panels' Vmp: ~6.0V, or 80–85% of the Voc you actually measure in open sun. All three panels are identical and parallel, so they share one setpoint.
- **Charge current** → check the default against the cell; up to ~1.5A is what the array can deliver anyway (6W ÷ ~3.5V, minus converter losses), well inside the board's 3A rating and the cell's rating.

You cannot "overload" the charger with too many panels — it draws what it draws. Extra panel capacity just means hitting the charge-current limit sooner.

**Energy budget reality:** under dappled canopy expect 5–15% of panel rating — roughly 1–3Wh on a bad day from the 6W array. The node budget (~20–30mAh/day ≈ 0.1Wh at 15 events) fits comfortably, and a full 32700 is 2+ months of zero-sun autonomy. But heavy video recording or HaLow traffic changes the math — log battery voltage for a couple of cloudy weeks at a new site before trusting the margin. The coastal marine layer (June gloom) is the same class of problem as tree canopy; treat it the same way.

---

## 4. Wiring order (one node, start to finish)

```
PANELS (3× parallel, combined at one point)
   │
   ├─ PV+ ──[ INA228 A shunt, ~10 mΩ ]── VIN+  ┐
   └─ PV– ─────────────────────────────── VIN–  │
                                                │  LiFePO4wered/Solar1
   CELL+ ─[ FUSE 2–3A ]─[ INA228 B shunt ]─ BAT+│  (CN3801 + LVD)
   CELL– ─────────────────────────────────  BAT–│
                                                │
   NODE 3V3 in ◄────────────────────────── VOUT+ ┘
   NODE GND   ◄────────────────────────── VOUT–
```

Order of operations when assembling: configure the Solar1 resistors first → connect battery (through fuse + shunt) → confirm VOUT shows battery voltage → connect the node to VOUT → connect panels last. Disassembly is the reverse: panels off first, battery off last.

Checklist before first power-up:

- [ ] Panels verified 6V-class (measured Voc)
- [ ] MPP resistor set for ~6V; charge-current resistor checked
- [ ] Fuse installed at cell + terminal
- [ ] Load wired to VOUT, nothing wired directly to battery
- [ ] Both INA228 shunts high-side, kelvin-connected
- [ ] Polarity triple-checked at every terminal block
- [ ] Cell voltage measured (a healthy resting LFP cell reads 3.2–3.35V)

---

## 5. Telemetry: two INA228s, and the sampling trap

**Placement.** INA228 **A**: high-side shunt in the PV+ lead, after the combiner (one device sees the whole array). Its VBUS channel also reads panel voltage — use it to verify the MPP setpoint is actually holding under canopy. INA228 **B**: high-side shunt between the fuse and the Solar1 BAT+ terminal (order: cell+ → fuse → shunt → BAT+), configured bidirectional. The battery position beats VOUT because it sees charge current in, load current out, and the net of both; at night, battery current *is* the load current, so load characterization comes free.

**Shunt values.** The 20-bit ADC lets us keep shunts tiny: ~5–10mΩ on the battery side (≤15mV drop at 1.5A — small enough that the CN3801's battery-voltage sensing and the 2.7V LVD threshold barely notice) and ~10mΩ on the PV side. Kelvin connections on all shunts.

**Electrical.** Everything high-side — the charger, LVD, and node share a ground reference, and a shunt in any ground return corrupts it. Power both chips from the node's 3.3V rail; put them on the node's I2C bus with distinct addresses via A0/A1. The VBUS input measures up to 85V independently of the 3.3V supply, so reading the ~7V panel rail is fine. Adafruit's INA228 breakout is fine for prototyping before we spin a carrier board.

**The sampling trap (important).** We planned ~10 reads/hour. That cadence is fine for battery voltage but will badly alias what we most care about: dappled-light harvest fluctuates on a seconds timescale, and the load is bursty — microamps of deep sleep punctuated by sub-second camera + HaLow bursts at hundreds of mA. Spot samples will land on sleep current nearly every time and report that the node consumes nothing.

**The fix is built into the chip:** the INA228 has 40-bit hardware **charge and energy accumulation registers**. Leave it converting continuously; each 10-per-hour read pulls integrated mAh and mWh since the last read — immune to aliasing, regardless of firmware sampling rate. It's a hardware coulomb counter, which also gives us the only good state-of-charge estimate available (LFP's flat voltage curve makes voltage-based SoC nearly useless between ~20% and ~90%).

Cost: ~0.6–0.7mA supply current while continuously converting ≈ 15mAh/day per device — comparable to the whole node budget but small next to even a bad day's harvest. Operating policy:

- **INA228 B (battery): continuous, 24/7.** Coulomb counting is worth it.
- **INA228 A (PV): continuous during daylight, shutdown at night** (~2–5µA in shutdown).
- Power-critical deployments only: fall back to one-shot conversions with 64–128 sample averaging at the 10/hour cadence, accepting sampled (not integrated) data.

**What each sample pushes to RTDB:** accumulated mWh harvested, accumulated net battery mAh, panel voltage, battery voltage. This gives the cloud side clean per-node daily energy curves and, after a month, real data on which of the 20 sites need bigger arrays.

---

## 6. Environment: coastal/marine and cold sites

**CA coastal/marine sites need no heater.** Coastal lows rarely hit freezing; LFP discharge is fine to −20°C, and the only restriction is charging below 0°C — which the Solar1's lockout handles by simply delaying the charge window an hour or two on the coldest mornings of the year. At our load, that's a rounding error.

**Cold deployments (Sierra, high desert, inland PNW) — add a heater pad.** The Solar1 drives it natively: attach a dumb resistive pad and the board powers it from the panel during under-temperature conditions, pulsing the current (rev 4) so the panel voltage doesn't collapse. Sizing: pick resistance so Vmp²/R ≤ array power → **≥6Ω for our 6V/6W array**. Options: Adafruit polyester film heating pads (~$4; the ~4–5Ω 10×5cm pad works with the pulsing, or two in series for a gentler ~3.5W), or generic adhesive Kapton/polyimide film heaters in whatever resistance we want (a 25×70mm strip wraps a 32700 nicely). Check sizing against Silicognition's heater docs before ordering. Two rules that matter more than the pad choice: **heat the cell, not the box** — wrap the pad around the 32700, then wrap that in closed-cell foam; and **couple the temperature sensing to the cell** — the Solar1's external thermistor gets taped to the battery under the insulation, or the heater logic mistimes in both directions.

**Salt air is the real killer at marine sites, not cold:**

- Conformal coat the Solar1 and camera boards (MG Chemicals 419D acrylic spray is the standard cheap answer). Mask connectors and the thermistor before spraying.
- Avoid cheap nickel-plated spring cell holders at marine sites — they corrode and fret. Use tabbed 32700s soldered to leads, or at minimum dielectric grease on holder contacts.
- Proper IP68 cable glands on every enclosure penetration; 316 SS hardware (same spec as the creek enclosures — salt spray is nastier than creek water).
- Add a membrane pressure-equalization vent (Gore-style M12 breathable plug) plus a desiccant pack. Sealed boxes breathing through daily thermal cycles inhale moist air past gaskets and condense it inside; the vent stops the pressure cycling, the desiccant catches the rest.

---

## 7. Quick-reference gotcha list

1. CN3791 ≠ CN3801. The 3791 is 4.2V Li-ion only. We use neither directly — the Solar1 has the CN3801 on it — but if anyone buys bare modules for experiments, this is the trap.
2. 32700 does not fit a D-cell holder (70mm vs 61.5mm long). Buy 32650/32700 holders.
3. IFR = LiFePO4. Same cylindrical sizes exist in 3.7V Li-ion chemistry; charging the wrong one on the wrong charger is dangerous in both directions.
4. Never wire the load to the battery. VOUT only. The LVD is the over-discharge protection.
5. Never bench-charge on a 4.2V Li-ion charger.
6. Fuse lives at the cell, not at the board.
7. High-side shunts only; no resistance in ground returns.
8. Keep shunts ≤10mΩ or the charger's voltage sensing and LVD thresholds shift.
9. Spot-sampling a bursty load lies to you. Use the INA228 accumulation registers.
10. Panels must be 6V-class. Parallel adds current, never voltage — three panels don't fix a too-low panel voltage.
11. No blocking diodes between identical parallel panels; they cost ~5% of harvest for nothing.
12. Marine sites: conformal coat, no bare spring contacts, vented + desiccated enclosures.
13. Heater pads: heat the cell (insulated wrap), thermistor on the cell, resistance ≥6Ω for our array.
14. Validate one coastal node through a full marine-layer month before cloning nineteen more.
