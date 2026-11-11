# GUITinstal — o app desktop

Sai do marketing para a realidade: o GUITinstal **analisa um repositório do GitHub, monta um plano de instalação e roda os comandos na sua máquina — um de cada vez, só depois da sua aprovação**.

Este diretório contém a aplicação real. A landing page (`../index.html`) continua separada e é o site de marketing.

## Como rodar

**Jeito mais simples:** dê dois cliques em `start.cmd`. Ele sobe o servidor local e abre a interface numa janela própria (sem barra de endereço), usando o Chrome ou o Edge instalado.

**Pelo terminal:**

```bash
cd app
node server/main.js --open      # abre a janela do app
node server/main.js             # sobe sem abrir nada
```

Não há dependências para instalar: o app roda em **Node puro**, sem `npm install`. Precisa de Node 24 ou superior para a biblioteca SQLite integrada.

O endereço aparece no terminal (ex.: `http://127.0.0.1:52310`) e é gravado em `%APPDATA%\GUITinstal\runtime.json`.

## O que ele faz

1. **Analisa** — você cola uma URL do GitHub (`github.com/usuario/projeto`, `owner/repo` ou `git@github.com:owner/repo.git`).
2. **Detecta a stack** — Node.js, Python, Docker, Go, Rust, Java, PHP, Ruby, .NET, Make — lendo `package.json`, `requirements.txt`, `go.mod`, `Dockerfile`, `compose.yaml`, `pom.xml` e outros manifestos.
3. **Monta o plano** — clone, ambiente virtual, instalação de dependências, build e inicialização. Cada passo mostra exatamente o comando que vai rodar, para que serve e qual o risco.
4. **Você aprova** — nada executa sem confirmação. Dá para aprovar passo a passo ou o plano inteiro de uma vez, pular passos opcionais e cancelar a qualquer momento.
5. **Executa de verdade** — `git clone`, `npm install`, `pip install`, `docker compose`, `cargo build`… rodam de fato, com a saída aparecendo ao vivo no console.
6. **Organiza e executa** — o projeto entra em *Meus projetos*, com o comando de inicialização guardado. Clique em **Guide** para o assistente ler localmente o manifesto, os scripts e as instruções de execução do README; ele explica como abrir e qual comando GUITinstal usará. Clique em **Run** para iniciar; apps web abrem no navegador automaticamente. Também dá para parar, ver o log, atualizar (`git pull --ff-only`), abrir a pasta e remover do registro.
7. **Adota o que já está no disco** — a *Galeria de repositórios* varre a pasta de trabalho (e a antiga `.guitinstal-workspace`) e lista todo repositório Git baixado, inclusive os de instalações interrompidas. *Adicionar a Meus projetos* registra a pasta sem clonar de novo e detecta o comando de início a partir dos arquivos locais.

## Segurança

- **Servidor local.** Escuta apenas em `127.0.0.1`, nunca em todas as interfaces.
- **Token de sessão.** Cada execução gera um token aleatório que é injetado na página. Requisições sem ele recebem `403`, e requisições com `Host` desconhecido também — isso bloqueia ataque de DNS rebinding vindo de outra página do navegador.
- **Sem shell.** Todos os comandos são executados com array de argumentos e `shell: false`. O conteúdo do repositório nunca é interpretado como sintaxe de shell. No Windows, o npm roda como `node npm-cli.js` justamente para não passar pelo `npm.cmd`.
- **Só GitHub.** Só URLs do github.com são aceitas.
- **Aprovação obrigatória.** O motor só executa um passo depois que ele foi aprovado explicitamente.
- **IA opcional e consentida.** O guia de projeto lê localmente os manifestos, scripts, trechos de execução do README e logs. Se você habilitar o envio para um provedor configurado como sem custo, a pergunta e esse contexto selecionado serão enviados; o reparo também envia o arquivo que você escolher. O app não verifica preços ou cotas do provedor. A proposta precisa ser revisada e aprovada antes de alterar o arquivo.
- **Verificação de disco.** Antes de instalar, o app confere o espaço livre na pasta de trabalho e avisa (ou bloqueia) se estiver crítico.
- **Risco rotulado.** Todo passo exibe seu nível de risco: baixo, médio ou alto.

## Estrutura

```
app/
├─ core/                 lógica pura, sem HTTP e sem DOM
│  ├─ paths.js           caminhos de dados e app
│  ├─ store.js           configurações e registro de projetos
│  ├─ repo-url.js        parsing e validação de URL
│  ├─ github.js          API do GitHub (repositório, árvore, busca, commits)
│  ├─ detect.js          detecção de stack
│  ├─ plan.js            montagem do plano de instalação
│  ├─ tools.js           resolução de executáveis e detecção de runtimes
│  ├─ disk.js            verificação de espaço livre
│  ├─ git.js             operações git
│  ├─ workspace.js       descoberta e importação de repositórios locais
│  └─ runner.js          motor de execução, aprovação e log ao vivo
├─ server/
│  ├─ main.js            servidor HTTP, estáticos, SSE, abertura da janela
│  └─ api.js             rotas JSON
├─ ui/                   interface (HTML, CSS, JS sem dependências)
├─ desktop/              wrapper Electron (janela nativa)
├─ tools/smoke.js        teste de ponta a ponta do fluxo real
└─ start.cmd             atalho para iniciar
```

O núcleo (`core/`) não sabe nada sobre HTTP nem sobre o navegador: é por isso que o mesmo código serve a interface web e a janela do Electron.

## Configurações

Em *Configurações*: pasta de trabalho, conexão opcional com GitHub (aumenta o limite da API de 60 para 5000 requisições/hora), provedores opcionais de IA compatíveis com OpenAI, clone raso, aprovação automática de passos de baixo risco e tema. As chaves de IA ficam separadas da configuração e são guardadas no armazenamento seguro do sistema quando disponível; nunca são devolvidas à interface. Configure somente provedores que você verificou como sem custo e escolha sua ordem de fallback. O app não valida preços ou cotas. A conexão do GitHub usa o Device Flow oficial e não pede acesso a repositórios privados. Depois de conectar, a aba *My GitHub* em Discover mostra até 100 repositórios públicos da conta, ordenados por atualização.

Em uma instalação nova, a pasta de trabalho padrão é `Desktop\Repositories` (ou `~/GUITinstal-workspace` quando não existe pasta Desktop). A galeria sempre varre a raiz configurada e, se existir, a pasta legada `.guitinstal-workspace` dentro dela: assim os clones feitos por versões antigas continuam visíveis mesmo depois de mudar a pasta de trabalho.

Dados locais em `%APPDATA%\GUITinstal` no Windows (em macOS/Linux, sob a pasta de dados do usuário):
- `config.json` — preferências; não contém o token do GitHub
- `library.sqlite` — biblioteca de projetos; o `projects.json` antigo é importado e preservado como backup
- `runtime.json` — porta e token da execução atual

O token fica no DPAPI do Windows ou no keyring Secret Service do Linux (`secret-tool`) quando disponível. No macOS e em Linux sem keyring configurado, ele fica somente na memória durante a sessão. O app informa esse estado em Configurações e nunca grava o token em texto simples.

## Verificação

```bash
npm run check                                  # sintaxe de todos os arquivos
node server/main.js                            # terminal 1
node tools/smoke.js sindresorhus/is            # terminal 2 — fluxo real completo
```

O smoke test analisa, aprova e executa cada passo de verdade e confere se o projeto entrou no registro.

## Empacotar como app desktop

O wrapper Electron já está pronto em `desktop/`. Ele sobe o mesmo servidor e abre a interface numa janela nativa.

```bash
npm install             # instala Electron e electron-builder
npm run desktop         # abre a janela durante o desenvolvimento
npm run dist:win        # Windows: instalador NSIS e portátil x64
npm run dist:mac        # macOS: DMG universal (Intel + Apple silicon)
npm run dist:linux      # Linux: AppImage x64
```

Os artefatos saem em `app/dist/`. Builds macOS devem ser gerados em um runner macOS; a automação de release usa runners nativos de cada sistema e publica os três formatos no GitHub Releases. macOS pode exibir o aviso de desenvolvedor não identificado, pois os builds não são assinados.

O site escolhe o download adequado ao sistema do visitante e lê os assets da release pública. Para publicar uma versão, crie e envie uma tag `v<versão>`; o workflow `../.github/workflows/release.yml` compila e publica os instaladores.

## Preparar uma versão manualmente

```bash
npm run release -- "O que mudou nesta versão"
```

Esse comando é o fluxo local de auditoria legado, focado no build Windows. Para publicar os três sistemas, atualize a versão e o changelog, envie a tag correspondente (`v<versão>`) ao GitHub e deixe `.github/workflows/release.yml` gerar e publicar os pacotes nativos.

## Limites conhecidos

- O plano assume um projeto por vez; não há fila de instalações.
- `docker compose up` usa a CLI do Docker: em máquinas só com Docker Desktop, o `docker` pode não estar no PATH do processo.
- O token do GitHub usa DPAPI no Windows e Secret Service no Linux quando disponível; no macOS fica apenas na memória. Nunca é gravado em texto simples ou em `config.json`.
- A versão web não substitui o empacotamento nativo: é a mesma interface servida por `localhost`.
