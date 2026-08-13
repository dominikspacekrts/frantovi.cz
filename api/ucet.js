/* =========================================================
   TRANSPARENTNÍ ÚČET — serverless funkce (Vercel)

   Vrací zůstatek a poslední pohyby na účtu 284051001/0600 jako JSON.
   Prohlížeč si je z moneta.cz stáhnout nemůže — stránka neposílá CORS
   hlavičky a má X-Frame-Options: SAMEORIGIN. Proto tenhle mezikrok:
   načte ji server a webu podá čistá data ze stejné domény.

   Data jsou uvnitř RSC payloadu stránky (Next.js) pod klíčem
   apiDetailResponse. Kdyby MONETA strukturu změnila, funkce vrátí chybu
   a web se sám přepne na prostý odkaz — nikdy neukáže zastaralá čísla.
   ========================================================= */

const UCET = '284051001';
const ZDROJ = `https://transparentniucty.moneta.cz/${UCET}`;
const MARKER = 'apiDetailResponse\\":';

/* creditDebitFlag: 4 = příchozí platba (ověřeno proti zůstatku účtu).
   Ostatní hodnoty bereme jako odchozí. Shodu hlídá příznak `sedi` níže —
   když nesedí, web schválně nezobrazí znaménka, aby netvrdil nesmysl. */
const PRICHOZI = 4;

/* Payload je JS řetězec uvnitř <script>, uvozovky v něm jsou escapované.
   Objekt najdeme počítáním složených závorek mimo řetězce. */
function vytahniObjekt(html) {
  const start = html.indexOf(MARKER);
  if (start === -1) throw new Error('apiDetailResponse ve stránce nenalezen');

  const text = html.slice(start + MARKER.length).replace(/\\"/g, '"');
  const od = text.indexOf('{');
  if (od === -1) throw new Error('začátek objektu nenalezen');

  let hloubka = 0;
  let vRetezci = false;
  let escapovano = false;

  for (let i = od; i < text.length; i++) {
    const z = text[i];
    if (escapovano) { escapovano = false; continue; }
    if (z === '\\') { escapovano = true; continue; }
    if (z === '"') { vRetezci = !vRetezci; continue; }
    if (vRetezci) continue;
    if (z === '{') hloubka++;
    else if (z === '}' && --hloubka === 0) return JSON.parse(text.slice(od, i + 1));
  }
  throw new Error('konec objektu nenalezen');
}

/* „Klestilová, Vanda" → „Vanda K." — dárce je poznat, plné jméno
   na benefičním webu nefiguruje. Na MONETĚ zůstává tak jako tak. */
function zkratJmeno(jmeno) {
  const cele = (jmeno || '').trim();
  if (!cele) return 'Anonymní dárce';

  if (cele.includes(',')) {
    const [prijmeni, krestni] = cele.split(',').map((c) => c.trim());
    return krestni ? `${krestni} ${prijmeni.charAt(0)}.` : prijmeni;
  }

  /* Bez čárky to nemusí být jméno člověka — firmy („ACME s.r.o.")
     necháváme celé, zkracujeme jen čisté dvojslovné jméno a příjmení. */
  const casti = cele.split(/\s+/);
  const jeJmeno = casti.length === 2 && casti.every((c) => !/[.\d]/.test(c));
  return jeJmeno ? `${casti[0]} ${casti[1].charAt(0)}.` : cele;
}

function prevedData(zdroj) {
  const pohyby = Array.isArray(zdroj.transactions) ? zdroj.transactions : [];

  const transakce = pohyby
    .map((t) => ({
      datum: t.transactionDate,
      jmeno: zkratJmeno(t.counterpartyAccountName),
      castka: Math.abs(Number(t.amount) || 0),
      prichozi: t.creditDebitFlag === PRICHOZI,
    }))
    .sort((a, b) => String(b.datum).localeCompare(String(a.datum)));

  const soucet = transakce.reduce((s, t) => s + (t.prichozi ? t.castka : -t.castka), 0);
  const zustatek = Number(zdroj.balance) || 0;

  return {
    zustatek,
    transakce,
    pocet: transakce.length,
    /* sedí součet pohybů se zůstatkem? Když ne, směr plateb neinterpretujeme. */
    sedi: Math.abs(soucet - zustatek) < 0.01,
    /* výpis MONETA nabízí jen za poslední 3 měsíce */
    uplnyVypis: zdroj.endOfTransactions === 'A',
    aktualizovano: new Date().toISOString(),
    zdroj: ZDROJ,
  };
}

module.exports = async (req, res) => {
  /* CDN drží odpověď 5 minut, ať se MONETA nezatěžuje každým návštěvníkem */
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');

  try {
    const odpoved = await fetch(ZDROJ, {
      headers: {
        'User-Agent': 'frantovi.cz (beneficni web, vypis transparentniho uctu)',
        'Accept-Language': 'cs',
      },
    });

    if (!odpoved.ok) throw new Error(`MONETA vrátila ${odpoved.status}`);

    res.status(200).json(prevedData(vytahniObjekt(await odpoved.text())));
  } catch (chyba) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ chyba: chyba.message, zdroj: ZDROJ });
  }
};

/* pro lokální test: node api/ucet.js */
module.exports.vytahniObjekt = vytahniObjekt;
module.exports.zkratJmeno = zkratJmeno;
module.exports.prevedData = prevedData;
