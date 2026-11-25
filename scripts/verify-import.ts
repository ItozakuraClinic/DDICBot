// Post-import verification: counts, created_at window, known-pair spot checks.
import pg from "pg";
import { loadHermesEnv } from "./_load-env.ts";

const c = new pg.Client({ connectionString: loadHermesEnv().NEON_DATABASE_URL });
c
  .connect()
  .then(async () => {
    const p = await c.query(
      "select count(*)::int n, min(created_at) mn, max(created_at) mx from ddi_pairs",
    );
    console.log("ddi_pairs:", JSON.stringify(p.rows[0]));
    const d = await c.query("select count(*)::int n from drugs");
    console.log("drugs:", d.rows[0].n);
    const s = await c.query(
      "select severity, count(*)::int n from ddi_pairs group by 1 order by 1",
    );
    console.log("severity:", JSON.stringify(s.rows));
    const w = await c.query(
      `select ingredient_id, canonical_en from drugs where canonical_en in
       ('Warfarin','Aspirin','Simvastatin','Fluconazole','Dabigatran') order by 2`,
    );
    console.log("spot drugs:", JSON.stringify(w.rows));
    const nm = await c.query(
      `select lang, count(*)::int n from drug_names group by 1 order by 1`,
    );
    console.log("drug_names by lang:", JSON.stringify(nm.rows));
    const zhmiss = await c.query(
      `select count(*)::int n from drugs d where not exists (
         select 1 from drug_names dn where dn.ingredient_id = d.ingredient_id and dn.lang = 'zh')`,
    );
    console.log("drugs without a zh name row:", zhmiss.rows[0].n);
    const zhSample = await c.query(
      `select dn.ingredient_id, d.canonical_en, dn.surface_name
       from drug_names dn join drugs d using (ingredient_id)
       where dn.lang = 'zh' order by random() limit 6`,
    );
    console.log("zh sample:", JSON.stringify(zhSample.rows, null, 1));
    // simvastatin x fluconazole pair
    const sf = await c.query(
      `select dp.severity, dp.drug_a_ingredient, dp.drug_b_ingredient
       from ddi_pairs dp
       join drugs da on da.ingredient_id = dp.drug_a_ingredient
       join drugs db on db.ingredient_id = dp.drug_b_ingredient
       where (da.canonical_en, db.canonical_en) in
             (('Simvastatin', 'Fluconazole'), ('Fluconazole', 'Simvastatin'))`,
    );
    console.log("simvastatin+fluconazole row:", JSON.stringify(sf.rows));
    // warfarin x aspirin (aspirin canonical_en is 'Acetylsalicylic acid')
    const wa = await c.query(
      `select dp.severity, da.canonical_en, db.canonical_en
       from ddi_pairs dp
       join drugs da on da.ingredient_id = dp.drug_a_ingredient
       join drugs db on db.ingredient_id = dp.drug_b_ingredient
       where (da.canonical_en, db.canonical_en) in
             (('Warfarin', 'Acetylsalicylic acid'), ('Acetylsalicylic acid', 'Warfarin'))`,
    );
    console.log("warfarin+aspirin row:", JSON.stringify(wa.rows));
    await c.end();
  })
  .catch((e: Error) => {
    console.error("FAIL:", e.message);
    process.exit(1);
  });
