// Ludra BR: what each boss of Abyssal Forge: Ludra does, in Portuguese.
//
// Two kinds of calls:
//  - "casts": the boss starts a skill the game shows (cast bar, line on screen).
//    These come from the game's own skill ids (the same ids Boss Callouts uses),
//    so they are always right when they fire.
//  - "hp": a mechanic the guides tie to the boss's HP. These are the guides'
//    numbers (mostly Korean); the plugin logs the HP at which each mechanic
//    really started, and "Ajustar pelo registro" moves the numbers to match.
//
// Skill ids: AION 2 Skill table, names in Portuguese as the game has them
// ("Provação de Ludra" 1803040, "Zona do Trovão" 1803030, ...).
window.LUDRA_BR = {
  bosses: {
    ludra: {
      name: "Ludra da Eternidade",
      short: "LUDRA",
      codes: [2301014, 2300290],
      // Enrage: 10 min, the guides say (not confirmed in the global version). Adjustable.
      enrage: 600,
      // Skill ids that only this boss uses: the first one seen tells the plugin who is who.
      // (8-digit ids are the 7-digit ones' variants: 1803xxx -> 1803xxx0-9. The
      // ranges stop where other bosses' skills start: Submerged Emon 1803570,
      // Terminator Bargott 1803810, Nuakum 1802020, Veltiras 1802220, Talisra
      // of the Void up to 1801780, as Boss Callouts has them.)
      skills: [[1803000, 1803399], [18030000, 18033999]],
      // 10000008: "A strength that has withstood eternity!" (Boss Callouts), Ludra's own buff.
      buffs: [10000008],
      // Global (NA/EU/SA) numbers first: AionFlex's Ludra guide (global
      // Normal, 14/11/2026) gives orbs 90%, arena 85%, Bingo 60%, Zikel 45%,
      // Colors 33%. Bingo 2 at 25% and the circles at 10% come from the
      // global early-access guide (aion2tierlist) and the Korean ones.
      hp: [
        { id: "orbes", pct: 90, title: "ORBES", sub: "Azul: todos pegam. Vermelho: só com bloqueio ou imunidade." },
        { id: "arena", pct: 85, title: "ARENA DIMINUI", sub: "Fiquem dentro: fora da borda tira 7 mil por segundo. Daqui a ordem dos ataques é sempre a mesma." },
        { id: "bingo1", pct: 50, title: "BINGO 1", sub: "Achem o quadrado azul. No atordoamento, BATAM TUDO.", learn: { skill: 1803040, nth: 1 } },
        { id: "zikel", pct: 45, title: "ZIKEL", sub: "Lasers em sequência. Desviem na ordem: sul, oeste, leste, norte." },
        { id: "cores", pct: 33, title: "CORES", sub: "Vermelho de um lado, azul do outro. Longe da outra cor." },
        { id: "bingo2", pct: 25, title: "BINGO 2", sub: "Igual ao Bingo 1, mas pulem as ondas antes. Healer: guarde a imunidade.", learn: { skill: 1803040, nth: 2 } },
        { id: "circulos", pct: 10, title: "CÍRCULOS", sub: "Um por círculo da sua cor. Entre só no último segundo.", learn: { skill: 1803030, nth: 1 } },
      ],
      casts: [
        { skill: 1803040, title: "BINGO!", sub: "Raio revela o quadrado. Todos no azul. Depois, batam tudo.", secs: 15 },
        { skill: 1803030, title: "CÍRCULOS!", sub: "Entre no da sua cor no último segundo. Um por círculo.", secs: 5 },
        { skill: 1803200, title: "ORBES", sub: "Azul: todos pegam. Vermelho: só com bloqueio ou imunidade." },
        { skill: 1803360, title: "ORBES", sub: "Azul: todos pegam. Vermelho: só com bloqueio ou imunidade." },
        // "Raio Estrondoso Violeta" ("O poder deve ser usado assim."): taken for
        // the global's bombs, three lightning bombs with tornados (Vinicius, 18/11).
        // Not confirmed: the log shows when it really comes.
        { skill: 1803010, title: "BOMBAS DE RAIO", sub: "Três bombas de raio e tornados. Longe das bombas, desviem dos tornados." },
      ],
      buffCalls: [
        { abnormal: 10000008, title: "LUDRA FORTALECIDO", sub: "Ele ganhou o poder da eternidade. Defesas prontas." },
      ],
    },
    rahu: {
      name: "Rahu da Disjunção",
      short: "RAHU",
      codes: [2301006, 2300282],
      skills: [[1802700, 1802999], [18027000, 18029999]],
      buffs: [],
      // The bomb (aion2-meta, aion2vault): a player carries it 20 s (purple
      // ring, green glow on the HP bar) and must pass it to someone next to
      // them; alone it leaves a puddle, three puddles wipe. Its skill id is
      // not known yet: the log keeps every Rahu skill seen, to find it.
      hp: [
        { id: "centro", pct: 75, title: "RAHU NO CENTRO", sub: "Ele joga todos longe. Juntem na pessoa marcada." },
        { id: "quadrantes", pct: 50, title: "ARENA EM 4", sub: "Todos no mesmo quadrante. Poças bem na borda." },
        { id: "comer", pct: 25, title: "HORA DE COMER", sub: "Mirem a linha vermelha nos adds. Add vivo vira poça.", learn: { skill: 1802980, nth: 1 } },
      ],
      casts: [
        { skill: 1802900, title: "RODA DO TORMENTO", sub: "Juntem na pessoa marcada e girem no sentido horário.", secs: 15 },
        { skill: 1802980, title: "HORA DE COMER", sub: "Mirem a linha vermelha nos adds. Add vivo vira poça." },
      ],
    },
    ketu: {
      name: "Asas Abissais Ketu",
      short: "KETU",
      codes: [2301007, 2300283],
      skills: [[1801800, 1801999]],
      buffs: [18019631],
      hp: [
        { id: "olhos", pct: 50, title: "OLHOS A PARTIR DE AGORA", sub: "Vermelho: olhe para ele. Azul: vire de costas.", learn: { skill: 1801962, nth: 1 } },
      ],
      casts: [
        { skill: 1801962, title: "OLHOS", sub: "Vermelho: olhe para ele. Azul: vire de costas." },
        { skill: 1801970, title: "PEDRAS DA ALMA", sub: "Quebre a pedra logo antes do dano. Não pegue a do Cleric.", secs: 9 },
      ],
      buffCalls: [
        { abnormal: 18019631, title: "ESCONDE-ESCONDE", sub: "Desvie do laser. Matem os espíritos indo para o norte." },
      ],
    },
  },
  // Below this HP no monster is taken for a boss until one of the skills above says so.
  minBossHp: 5000000,
};
