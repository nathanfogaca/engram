import { memo, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { onboarding, questions, themes, tools, views } from "./catalog";
import { useHeroPointer, useViewportMotion } from "./motion";

const github = "https://github.com/nathanfogaca/engram";
const download = `${github}/releases/latest/download/Engram-windows-x64.exe`;
const integrations = [
  ["Claude Code", "claude-code.png"],
  ["Codex", "codex.png"],
  ["Gemini CLI", "gemini-cli.png", true],
  ["OpenCode", "opencode.svg", true],
];
const iconPaths = {
  arrow: "M5 12h14m-6-6 6 6-6 6",
  external: "M7 17 17 7M7 7h10v10",
  download: "M12 3v12m-4-4 4 4 4-4M5 20h14",
  expand: "M8 4H4v4m12-4h4v4m0 8v4h-4M4 16v4h4",
  close: "m6 6 12 12M18 6 6 18",
  network: "M12 7v4m0 0-6 4m6-4 6 4M9 3h6v4H9zM3 15h6v6H3zm12 0h6v6h-6z",
  brain: "M12 7c-1-4-7-4-7 0-3 1-3 5-1 6-1 3 1 6 4 6 1 3 4 1 4-1V7Zm0 0c1-4 7-4 7 0 3 1 3 5 1 6 1 3-1 6-4 6-1 3-4 1-4-1M5 7c0 2 1 3 3 3m11-3c0 2-1 3-3 3M4 13l4 1m12-1-4 1",
  flow: "M5 4h5v5H5zm9 11h5v5h-5zM7.5 9v5a3.5 3.5 0 0 0 3.5 3.5h3m-4-11h4a3 3 0 0 1 3 3V12",
  code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-16-2 20",
  reader: "M4 6c3-2 6-2 8 0 2-2 5-2 8 0v13c-3-2-6-2-8 0-2-2-5-2-8 0V6Zm8 0v13",
  plus: "M12 5v14M5 12h14",
  plug: "M9 3v5m6-5v5M7 8h10v3a5 5 0 0 1-10 0V8Zm5 8v5",
  spark: "M12 2c0 7 3 10 10 10-7 0-10 3-10 10 0-7-3-10-10-10 7 0 10-3 10-10Z",
  shield: "m12 3 8 3v5c0 5-4 8-8 10-4-2-8-5-8-10V6l8-3Zm-3 9 2 2 4-4",
  layers: "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5m-18 5 9 5 9-5",
  menu: "M4 6h16M4 12h16M4 18h16",
};

function Icon({ name, size = 18 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name]} /></svg>;
}

function Brand() {
  return <a href="#inicio" className="brand" aria-label="Engram, início">
    <img src="img/engram.png" alt="" width="32" height="32" />Engram<span className="brand-dot" aria-hidden="true">.</span>
  </a>;
}

function Header() {
  const mobileMenu = useRef(null);
  const links = [["#produto", "Produto"], ["#recursos", "Recursos"], ["#temas", "Temas"], ["#perguntas", "FAQ"]];
  return <header className="topbar">
    <div className="wrap topbar-inner">
      <Brand />
      <nav className="top-nav" aria-label="Navegação principal">
        {links.map(([href, label]) => <a key={href} href={href}>{label}</a>)}
      </nav>
      <div className="top-actions">
        <a className="repo-link" href={github} target="_blank" rel="noopener">GitHub <Icon name="external" size={14} /></a>
        <details className="mobile-menu" ref={mobileMenu}>
          <summary aria-label="Menu"><Icon name="menu" /></summary>
          <nav aria-label="Navegação móvel">
            {links.map(([href, label]) => <a key={href} href={href} onClick={() => { mobileMenu.current.open = false; }}>{label}</a>)}
          </nav>
        </details>
        <a className="button button-small" href="#baixar"><Icon name="download" size={15} /> Baixar</a>
      </div>
    </div>
  </header>;
}

function starPosition(seed) {
  const fraction = Math.sin(seed) * 10000;
  return fraction - Math.floor(fraction);
}

const stars = Array.from({ length: 39 }, (_, i) => ({
  x: 1440 * starPosition(i * 73 + 11),
  y: 760 * starPosition(i * 101 + 37),
  r: i % 7 === 0 ? 1.7 : .9,
}));
const connections = stars.flatMap((star, index) => stars.slice(index + 1)
  .filter(next => Math.hypot(star.x - next.x, star.y - next.y) < 132)
  .map(next => `M${star.x.toFixed(1)},${star.y.toFixed(1)}L${next.x.toFixed(1)},${next.y.toFixed(1)}`)).join(" ");

function SignalField() {
  return <svg className="signal-field" viewBox="0 0 1440 760" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <path d={connections} fill="none" stroke="#8b7bff" strokeOpacity=".25" />
    {stars.map(({ x, y, r }) => <circle key={x} cx={x} cy={y} r={r} fill="#b9beff" fillOpacity=".54" />)}
  </svg>;
}

function Screen({ item, open, eager = false, fit = "fill", sizes }) {
  return <button className={`screen screen-${fit}`} type="button" onClick={() => open(item)} aria-label={`Ampliar. ${item.alt}`}>
    <img key={item.src} src={item.src} srcSet={item.previews} sizes={item.previews && sizes} alt={item.alt} width={item.size[0]} height={item.size[1]} loading={eager ? "eager" : "lazy"} fetchPriority={eager ? "high" : "auto"} decoding={eager ? "sync" : "async"} />
    <span className="expand-icon"><Icon name="expand" size={17} /></span>
  </button>;
}

function ProductConsole({ open }) {
  const [selected, setSelected] = useState(0);
  const item = views[selected];
  return <div className="console" id="produto" aria-label="Explore o Engram">
    <div className="console-top">
      <span className="console-id"><span className="status-dot" data-pulse="" />Engram</span>
      <span className="mono console-tag">Modo demonstração</span>
    </div>
    <div id="product-screen"><Screen item={item} open={open} eager={selected === 0} sizes="(max-width: 800px) calc(100vw - 32px), (max-width: 1080px) 55vw, (max-width: 1316px) 58vw, 740px" /></div>
    <div className="console-controls" role="group" aria-label="Vistas do Engram">
      {views.map(({ label, icon, id }, index) => <button key={id} type="button" aria-pressed={selected === index} aria-controls="product-screen" onClick={() => setSelected(index)}><Icon name={icon} size={16} /> {label}</button>)}
    </div>
    <div className="console-caption" aria-live="polite">
      <strong>{item.title}</strong><span>{item.text}</span>
    </div>
  </div>;
}

function Hero({ open }) {
  const copy = useRef(null);
  const light = useRef(null);
  useHeroPointer(copy, light);
  return <section className="hero" aria-labelledby="headline">
    <SignalField />
    <div className="wrap hero-layout">
      <div className="hero-copy" ref={copy}>
        <div className="pointer-light" ref={light} aria-hidden="true" />
        <p className="kicker hero-kicker"><span className="status-dot" data-pulse="" /> Orquestração visual de agentes</p>
        <h1 id="headline"><span>Seu time de IA,</span><br /><span className="hero-accent">em sintonia.</span></h1>
        <p className="hero-lead">Conecte Claude Code e Codex em um palco visual. Divida tarefas, compartilhe memória e veja o trabalho avançar no seu computador.</p>
        <div className="button-row">
          <a className="button button-primary" href={download}><Icon name="download" /> Baixar para Windows</a>
          <a className="button button-quiet" href="#como-funciona">Como funciona <Icon name="arrow" size={17} /></a>
        </div>
        <p className="hero-meta mono">Windows 10 e 11 · 64 bits · Código aberto</p>
      </div>
      <ProductConsole open={open} />
    </div>
    <div className="wrap provider-strip">
      <span className="mono">Integrações</span>
      <div>
        {integrations.map(([name, icon, experimental]) => <span key={name}>
          <img src={`img/brands/${icon}`} width="20" height="20" alt="" decoding="async" />
          {name}{experimental && <small>Experimental</small>}
        </span>)}
      </div>
    </div>
  </section>;
}

const workflow = [
  { icon: "network", title: "Conecte", text: "Desenhe uma linha entre dois cartões. Por ela, os agentes trocam pedidos, resultados e revisões." },
  { icon: "layers", title: "Coordene", text: "Dê um objetivo ao maestro. Ele distribui as tarefas e reúne o que cada especialista entregou." },
  { icon: "brain", title: "Lembre", text: "Guarde decisões em notas Markdown conectadas. O time pode consultar o contexto antes de começar a próxima tarefa." },
];

function SectionHeading({ number, label, title, children }) {
  return <div className="section-heading" data-reveal="">
    <p className="kicker"><span>{number}</span> {label}</p>
    <h2>{title}</h2>
    {children && <p className="section-lead">{children}</p>}
  </div>;
}

function Workflow() {
  return <section className="wrap section" id="como-funciona">
    <SectionHeading number="01" label="Como funciona" title="Uma tarefa. Um time inteiro.">Do primeiro pedido à próxima entrega, cada agente sabe onde contribuir.</SectionHeading>
    <div className="workflow-grid">
      {workflow.map(({ icon, title, text }, index) => <article className="workflow-card" key={title}>
        <div className="workflow-top"><span className="tile-icon" data-reveal=""><Icon name={icon} size={22} /></span><span className="mono">0{index + 1}</span></div>
        <h3>{title}</h3>
        <p>{text}</p>
      </article>)}
    </div>
  </section>;
}

function Toolbox({ open }) {
  const [selected, setSelected] = useState(0);
  const item = tools[selected];
  return <section className="wrap section" id="recursos">
    <SectionHeading number="02" label="Recursos" title="Controle o trabalho de perto.">Acompanhe as conversas e configure o que cada agente pode fazer.</SectionHeading>
    <div className="toolbox">
      <div className="toolbox-side">
        <div className="tool-list" role="group" aria-label="Recursos do Engram">
          {tools.map(({ label, icon }, index) => <button type="button" key={label} aria-pressed={selected === index} aria-controls="tool-preview" onClick={() => setSelected(index)}>
            <Icon name={icon} /> <span>{label}</span> <Icon name="arrow" size={15} />
          </button>)}
        </div>
        <div className="tool-detail" aria-live="polite"><h3>{item.title}</h3><p>{item.text}</p></div>
      </div>
      <div className="tool-preview" id="tool-preview">
        <Screen item={item} open={open} fit="contain" sizes="(max-width: 800px) calc(100vw - 60px), (max-width: 1316px) 60vw, 790px" />
      </div>
    </div>
  </section>;
}

function ThemeLab({ open }) {
  const [selected, setSelected] = useState(0);
  const theme = themes[selected];
  return <section className="section theme-section" id="temas">
    <div className="wrap theme-layout">
      <div>
        <SectionHeading number="03" label="Temas" title="Um palco com a sua cara.">Alterne entre seis temas. A aparência muda na hora e fica salva no app.</SectionHeading>
        <div className="theme-choices" role="group" aria-label="Temas do Engram">
          {themes.map(({ label, color }, index) => <button type="button" key={label} style={{ "--swatch": color }} aria-pressed={selected === index} aria-controls="theme-screen" onClick={() => setSelected(index)}><span />{label}</button>)}
        </div>
      </div>
      <figure className="theme-frame" style={{ "--active-theme": theme.color }}>
        <div id="theme-screen"><Screen item={theme} open={open} sizes="(max-width: 800px) calc(100vw - 32px), (max-width: 1316px) 58vw, 735px" /></div>
        <figcaption className="mono" data-reveal=""><span /> Tema {theme.label}</figcaption>
      </figure>
    </div>
  </section>;
}

function Setup({ open }) {
  return <section className="wrap section" id="primeiro-uso">
    <SectionHeading number="04" label="Primeiro uso" title="Do download ao primeiro time.">O guia do Engram acompanha você na configuração e deixa o palco pronto para começar.</SectionHeading>
    <div className="setup-grid">
      {onboarding.map((item, index) => <article className="setup-card" key={item.title}>
        <Screen item={item} open={open} fit="contain" />
        <div className="setup-caption" data-reveal=""><span className="mono">0{index + 1}</span><div><h3>{item.title}</h3><p>{item.text}</p></div></div>
      </article>)}
    </div>
  </section>;
}

function Download() {
  return <section className="wrap section" id="baixar">
    <div className="download-panel">
      <div className="download-copy" data-reveal="">
        <p className="kicker"><span className="status-dot" /> Disponível para Windows</p>
        <h2>Seu palco está pronto.</h2>
        <p>Instale o Engram e conecte a conta do primeiro agente para começar.</p>
        <div className="button-row">
          <a className="button button-primary" href={download}><Icon name="download" /> Baixar para Windows</a>
          <a className="button button-quiet" href={`${github}/releases`} target="_blank" rel="noopener">Todas as versões <Icon name="external" size={16} /></a>
        </div>
      </div>
      <div className="orbit" aria-hidden="true"><div /><div /><div /><img src="img/engram.png" alt="" width="144" height="144" data-pulse="" /></div>
    </div>
  </section>;
}

function FAQ() {
  return <section className="wrap section faq" id="perguntas">
    <SectionHeading number="05" label="FAQ" title="Perguntas frequentes." />
    <div className="questions">
      {questions.map(([question, answer]) => <details key={question}><summary>{question}<Icon name="plus" size={19} /></summary><p>{answer}</p></details>)}
    </div>
  </section>;
}

function Lightbox({ image, close }) {
  const dialog = useRef(null);
  useEffect(() => {
    if (image && !dialog.current.open) dialog.current.showModal();
  }, [image]);
  return <dialog className="lightbox" ref={dialog} onClose={close} onClick={e => { if (e.target === e.currentTarget) e.currentTarget.close(); }} aria-labelledby="lightbox-title">
    {image && <div className="lightbox-inner">
      <div className="lightbox-top"><span id="lightbox-title">{image.label || image.title || "Captura do Engram"}</span><button type="button" autoFocus onClick={() => dialog.current.close()} aria-label="Fechar captura"><Icon name="close" /></button></div>
      <img src={image.src} alt={image.alt} />
    </div>}
  </dialog>;
}

const LandingContent = memo(function LandingContent({ open }) {
  const page = useRef(null);
  useViewportMotion(page);
  return <>
    <a href="#inicio" className="skip-link">Ir para o conteúdo</a>
    <Header />
    <main id="inicio" ref={page}>
      <Hero open={open} />
      <Workflow />
      <Toolbox open={open} />
      <ThemeLab open={open} />
      <Setup open={open} />
      <Download />
      <FAQ />
    </main>
    <footer className="footer"><div className="wrap">
      <Brand />
      <span>Um palco para o seu time de agentes.</span>
      <a href={github} target="_blank" rel="noopener">Código no GitHub <Icon name="external" size={16} /></a>
    </div></footer>
  </>;
});

function App() {
  const [image, setImage] = useState(null);
  return <>
    <LandingContent open={setImage} />
    <Lightbox image={image} close={() => setImage(null)} />
  </>;
}

createRoot(document.getElementById("root")).render(<App />);
