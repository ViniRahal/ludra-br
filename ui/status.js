// What the program can see right now, in words: Npcap missing, the game not
// found yet, or all good.
(function () {
  const box = document.querySelector(".status");
  function show(kind, title, text, button) {
    box.hidden = false;
    box.className = `status ${kind}`;
    box.replaceChildren();
    const b = document.createElement("b");
    b.textContent = title;
    box.append(b, document.createTextNode(text));
    if (button) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn";
      btn.textContent = button.label;
      btn.addEventListener("click", button.run);
      box.append(document.createElement("br"), btn);
    }
  }
  const render = (s) => {
    if (s.capture === "starting") return show("wait", "Iniciando…", "");
    if (s.capture === "npcap")
      return show("bad", "Falta o Npcap", "O Ludra BR lê a luta pelo Npcap, o mesmo que os medidores de DPS usam. Instale (é grátis), deixe as opções como vierem e abra o Ludra BR de novo.", { label: "Baixar o Npcap", run: () => a2.openNpcap() });
    if (s.capture === "devices")
      return show("bad", "Sem acesso à rede", "O Npcap foi instalado só para administrador. Feche e abra o Ludra BR com o botão direito > Executar como administrador.");
    if (!s.game) return show("wait", "Esperando o jogo", "Abra o AION 2 e entre no mapa. Ele acha o jogo sozinho em poucos segundos.");
    show("ok", "Jogo encontrado", "Tudo pronto. Os avisos aparecem quando a luta começar.");
    last = s;
    count();
  };
  let last = null;
  // Proof it reads the fight: how many of the boss's records came so far.
  function count() {
    if (!last || !last.game || box.hidden) return;
    let c = box.querySelector(".seen");
    if (!c) {
      c = document.createElement("div");
      c.className = "seen note";
      box.append(c);
    }
    const n = (v) => v.toLocaleString("pt-BR");
    c.textContent = a2.seen.hp || a2.seen.skill ? `Lido até agora: ${n(a2.seen.hp)} vidas de boss, ${n(a2.seen.skill)} mecânicas.` : "Nenhum boss lido ainda.";
  }
  setInterval(count, 2000);
  a2.on("status", render);
  window.__TAURI__?.core.invoke("status").then((s) => s && render(s));
})();
