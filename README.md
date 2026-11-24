# Ludra BR

Avisos das mecânicas do **Ludra** (Abyssal Forge) (AION 2) em português, com texto grande na tela e voz, painel do boss e medidor de dano.

## Baixar

**[Baixar o instalador para Windows](https://github.com/ViniRahal/ludra-br/raw/main/download/LudraBR-Instalador.exe)** (versão 0.7.34, cerca de 1,6 MB)

1. Instale o **Npcap**: https://npcap.com/#download. Quem já usa Questlog, A2Tools ou outro medidor de DPS já tem.
2. Abra o instalador. Se o Windows mostrar "O Windows protegeu o computador", clique em **Mais informações** e depois em **Executar assim mesmo**. O aviso aparece porque o programa ainda não tem assinatura digital.
3. Abra o Ludra BR antes de entrar no jogo. Jogue em "Janela sem bordas".

## O que ele faz

- Lê a vida do boss em % e avisa cada mecânica na hora certa, com texto e voz. A voz pode ser desligada.
- **Painel do boss**: vida em %, "mata em" (pelo dano do grupo), barra de stagger, contagem do enrage e quem está com o aggro.
- **Barra de cast do boss**: quando o boss começa uma mecânica, o nome dela, uma barra com o tempo até sair e em quem ele mira (vermelho quando é em você). Caixa própria, arraste para onde quiser; dá para ligar e desligar, esconder o alvo, mostrar a dica, mostrar habilidades sem aviso e mudar o tamanho. Ideia do "Boss cast bar" do Aion-DPS-Meter (MIT).
- **Medidor de dano** por jogador: DPS, dano dos últimos 10 segundos e total.
- **Esconder nomes** (para gravar ou fazer live): troca o nome dos jogadores por "Jogador 1, 2, 3" ou "Gladiador 1, Clérigo 2" no medidor, no quadro da party, no painel do boss, na barra de cast, no "o que te matou", no resumo e no histórico. Dá para manter o seu nome, escolher se esconde só no jogo ou na janela do app também, ligar e desligar por um botão embaixo do medidor (com as caixas destravadas) e ver um aviso na tela quando muda. As imagens copiadas também escondem. Só muda o que aparece: as lutas salvas e o registro ficam com os nomes de verdade.

### Mecânicas avisadas

| Boss | Pela % de vida | Quando o boss usa |
|---|---|---|
| Ludra da Eternidade | Orbes 90%, Arena diminui 85%, Bingo 1 50%, Zikel 45%, Cores 33%, Bingo 2 25%, Círculos 10%; enrage 10 min | Bingo, Círculos, Orbes, Bombas de raio (a confirmar) |
| Rahu da Disjunção | Rahu no centro 75%, Arena em 4 50%, Hora de comer 25% | Roda do Tormento, Hora de comer |
| Asas Abissais Ketu | Olhos 50% | Olhos, Pedras da Alma, Esconde-esconde |

As porcentagens vêm dos guias do servidor global e podem ser ajustadas no programa.

## Segurança

O programa só lê, de forma passiva, os dados que o servidor do jogo manda para o seu PC, como os medidores de DPS. Ele não mexe no jogo, não lê a memória do jogo e não envia nada pela internet.

## Código

Rust + Tauri. Código aberto sob a licença GPL-3.0 (veja `LICENSE`). A leitura dos pacotes e o medidor de dano usam partes do [A2Tools DPS Meter](https://github.com/taengu/A2Tools-DPS-Meter), também GPL-3.0, em `vendor/a2tools`.

Para compilar o instalador a partir do Linux: `cargo build --release --target x86_64-pc-windows-gnu` e depois `makensis installer/ludra-br.nsi`. Testes: `cargo test --no-default-features` e `node tests/*.mjs`.

Não é da NCSOFT nem da equipe do A2Tools.
