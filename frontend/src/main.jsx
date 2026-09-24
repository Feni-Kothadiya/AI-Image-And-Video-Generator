import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  LayoutDashboard,
  Layers,
  Type,
  Coins,
  Image,
  Users,
  Activity,
  Flag,
  History,
  Plug,
  Settings,
  LogOut,
  ChevronRight,
  Search,
  Plus,
  ArrowUpRight,
  Check,
  X,
  Upload,
  Save,
  Send,
  RefreshCw,
  Shield,
  Menu,
  Sparkles,
  Smartphone,
  Eye,
  Trash2,
  CircleHelp,
} from "lucide-react";
import { api, setCsrf } from "./api";
import "./style.css";
import "./overrides.css";

const navigation = [
  [
    "WORKSPACE",
    [
      ["Overview", LayoutDashboard],
      ["App content", Smartphone],
      ["Templates", Layers],
      ["Text library", Type],
      ["Coins & plans", Coins],
      ["Media library", Image],
    ],
  ],
  [
    "OPERATIONS",
    [
      ["Users", Users],
      ["Generations", Activity],
      ["Reports", Flag],
      ["Purchases", Coins],
    ],
  ],
  [
    "SYSTEM",
    [
      ["Publish history", History],
      ["Integrations", Plug],
      ["Audit log", Shield],
      ["Security", Settings],
    ],
  ],
];
const descriptions = {
  Overview: "Your app, at a glance.",
  "App content": "Shape the experience your users see.",
  Templates: "Build collections that inspire the next creation.",
  "Text library": "Every word, managed in one place.",
  "Coins & plans": "Set generation costs, daily rewards, and product displays.",
  "Media library": "Original artwork for your app and collections.",
  Users: "Manage accounts, balances, and access.",
  Generations: "Track requests from queue to completion.",
  Reports: "Review feedback and reported content.",
  Purchases:
    "Verified transactions will appear after Google Play is connected.",
  "Publish history": "Review releases and restore a previous draft.",
  Integrations: "Connect the services that power creation.",
  "Audit log": "A record of administrative changes.",
  Security: "Keep your workspace access secure.",
};
const fmt = (n) => new Intl.NumberFormat("en-IN").format(n || 0);
const date = (s) =>
  new Date(s).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
function Button({ children, icon: Icon, variant = "", ...props }) {
  return (
    <button className={"button " + variant} {...props}>
      {Icon && <Icon size={16} />} {children}
    </button>
  );
}
function Field({ label, hint, textarea = false, children, ...props }) {
  return (
    <label className={"field " + (props.className || "")}>
      <span>{label}</span>
      {children ||
        (textarea ? <textarea rows={4} {...props} /> : <input {...props} />)}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Badge({ children, tone = "" }) {
  return <span className={"badge " + tone}>{children}</span>;
}
function Empty({ title, children }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Layers size={26} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function Panel({ title, description, children, action, className = "" }) {
  return (
    <section className={"panel " + className}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
function Toggle({ label, checked, onChange, hint }) {
  return (
    <label className="toggle-row">
      <span>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track" />
    </label>
  );
}
function Modal({ title, children, onClose, wide = false }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={"modal " + (wide ? "wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function SearchBox({ value, onChange, placeholder = "Search..." }) {
  return (
    <div className="search">
      <Search size={17} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
function Pager({ page, total, onPage, size = 30 }) {
  return (
    <div className="pager">
      <span>
        {fmt(total)} total · Page {page}
      </span>
      <Button disabled={page === 1} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <Button disabled={page * size >= total} onClick={() => onPage(page + 1)}>
        Next
      </Button>
    </div>
  );
}
function useData(path, revision = 0) {
  const [data, setData] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setError("");
    setData(null);
    api(path)
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [path, revision]);
  return [data, error];
}
function Load({ error }) {
  return error ? (
    <div role="alert" className="callout danger">
      {error}
    </div>
  ) : (
    <div className="loading">
      <span className="spinner" />
      Loading workspace data…
    </div>
  );
}

function Login({ onLogin }) {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api("/login", "POST", { email, password });
      setCsrf(data.csrf);
      onLogin(data.user);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-story">
        <div className="wordmark">
          <img src="/seed-assets/brand-icon.png" />
          Creator Studio
        </div>
        <Badge tone="blue">YOUR CREATIVE CONTROL ROOM</Badge>
        <h1>
          A whole world of
          <br />
          creation.
          <br />
          <em>Under your control.</em>
        </h1>
        <p>
          Content, templates, coins, and the services behind your app. One
          thoughtful workspace.
        </p>
        <div className="login-art">
          <img src="/seed-assets/portrait.png" />
          <img src="/seed-assets/flowers.png" />
          <img src="/seed-assets/city.png" />
        </div>
        <small>Genora AI Image &amp; Video Editor · Android</small>
      </div>
      <div className="login-form">
        <form onSubmit={submit}>
          <div className="login-symbol">
            <Shield size={25} />
          </div>
          <h2>Welcome to your studio</h2>
          <p>Sign in to manage your app.</p>
          {error && (
            <div role="alert" className="callout danger">
              {error}
            </div>
          )}
          <Field
            label="Admin login ID or email"
            type="text"
            autoComplete="username"
            value={email}
            required
            onChange={(e) => setEmail(e.target.value)}
          />
          <Field
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            required
            minLength={1}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button variant="primary" disabled={busy} icon={ArrowUpRight}>
            {busy ? "Signing in…" : "Sign in to dashboard"}
          </Button>
          <div className="login-help">
            <CircleHelp size={16} />
            <span>
              Your initial login is in the local admin-credentials.txt file.
              Contact the server owner if you need access.
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}
function Dashboard() {
  const [user, setUser] = useState(null),
    [checking, setChecking] = useState(true),
    [page, setPage] = useState("Overview"),
    [revision, setRevision] = useState(0);
  const [content, setContent] = useState(null),
    [saved, setSaved] = useState(""),
    [draftVersion, setDraftVersion] = useState(0),
    [published, setPublished] = useState(null);
  const [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [busy, setBusy] = useState(false),
    [publish, setPublish] = useState(false),
    [note, setNote] = useState(""),
    [menu, setMenu] = useState(false);
  useEffect(() => {
    api("/session")
      .then((d) => {
        setCsrf(d.csrf);
        setUser(d.user);
      })
      .catch(() => { })
      .finally(() => setChecking(false));
  }, []);
  useEffect(() => {
    if (user) loadContent();
  }, [user]);
  const dirty = content && JSON.stringify(content) !== saved;
  useEffect(() => {
    const handler = (e) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  async function run(task, message) {
    setBusy(true);
    setError("");
    try {
      await task();
      if (message) setToast(message);
      setRevision((v) => v + 1);
    } catch (e) {
      setError(e.message);
      if (e.status === 401) {
        setUser(null);
        setCsrf("");
      }
    } finally {
      setBusy(false);
    }
  }
  function acceptDraft(d) {
    setContent(d.content);
    setSaved(JSON.stringify(d.content));
    setDraftVersion(d.version);
  }
  async function loadContent() {
    try {
      const d = await api("/content");
      acceptDraft(d.draft);
      setPublished(d.published);
    } catch (e) {
      setError(e.message);
    }
  }
  function update(fn) {
    setContent((old) => {
      const next = structuredClone(old);
      fn(next);
      return next;
    });
  }
  async function save() {
    await run(async () => {
      const d = await api("/content", "PUT", {
        version: draftVersion,
        content,
      });
      acceptDraft(d.draft);
    }, "Draft saved. The app still uses your published version.");
  }
  async function publishDraft(e) {
    e.preventDefault();
    await run(async () => {
      const d = await api("/content/publish", "POST", {
        version: draftVersion,
        note,
      });
      acceptDraft(d.draft);
      setPublished(d.published);
      setPublish(false);
      setNote("");
    }, "Published. The app will refresh its content shortly.");
  }
  const shared = { run, busy, revision };
  if (checking) return <Load />;
  if (!user) return <Login onLogin={setUser} />;
  let screen;
  if (page === "Overview") screen = <Overview {...shared} onPage={setPage} />;
  else if (
    ["App content", "Templates", "Text library", "Coins & plans"].includes(
      page,
    ) &&
    !content
  )
    screen = <Load />;
  else if (page === "App content")
    screen = <ContentEditor content={content} update={update} />;
  else if (page === "Templates")
    screen = <TemplatesEditor content={content} update={update} />;
  else if (page === "Text library")
    screen = <TextEditor content={content} update={update} />;
  else if (page === "Coins & plans")
    screen = <EconomyEditor content={content} update={update} />;
  else if (page === "Media library") screen = <MediaLibrary {...shared} />;
  else if (page === "Users") screen = <UserManager {...shared} />;
  else if (page === "Generations") screen = <Jobs {...shared} />;
  else if (page === "Reports") screen = <Reports {...shared} />;
  else if (page === "Purchases") screen = <Purchases {...shared} />;
  else if (page === "Publish history")
    screen = (
      <Releases
        {...shared}
        draftVersion={draftVersion}
        dirty={dirty}
        onRestore={acceptDraft}
      />
    );
  else if (page === "Integrations") screen = <Integrations {...shared} />;
  else if (page === "Security") screen = <Security {...shared} />;
  else screen = <AuditLog {...shared} />;
  return (
    <div className="app-shell">
      <aside className={"sidebar " + (menu ? "open" : "")}>
        <div className="wordmark">
          <img src="/seed-assets/brand-icon.png" />
          <span>
            Creator Studio<small>APP MANAGEMENT</small>
          </span>
        </div>
        <div className="workspace-card">
          <div className="workspace-icon">
            <Sparkles size={19} />
          </div>
          <div>
            <strong>AI Creator</strong>
            <span>Android workspace</span>
          </div>
          <Badge>LOCAL</Badge>
        </div>
        <nav>
          {navigation.map(([label, items]) => (
            <div className="nav-group" key={label}>
              <p>{label}</p>
              {items.map(([name, Icon]) => (
                <button
                  key={name}
                  className={page === name ? "active" : ""}
                  onClick={() => {
                    setPage(name);
                    setMenu(false);
                  }}
                >
                  <Icon size={18} />
                  {name}
                  {page === name && <span className="nav-dot" />}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="avatar">A</div>
          <div>
            <strong>Administrator</strong>
            <small>{user.email}</small>
          </div>
          <button
            aria-label="Sign out"
            className="icon-button"
            onClick={() =>
              run(async () => {
                await api("/logout", "POST", {});
                setUser(null);
                setContent(null);
                setCsrf("");
              })
            }
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button
            className="icon-button menu-button"
            aria-label="Toggle navigation"
            onClick={() => setMenu(!menu)}
          >
            <Menu />
          </button>
          <div className="breadcrumb">
            Workspace <ChevronRight size={14} /> <strong>{page}</strong>
          </div>
          <div className="top-actions">
            <span className="connection">
              <i />
              Backend connected
            </span>
            <a
              className="api-link"
              href="/api/config"
              target="_blank"
              rel="noreferrer"
            >
              Live app config <ArrowUpRight size={14} />
            </a>
            <div className="avatar">A</div>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                CREATOR STUDIO / {page.toUpperCase()}
              </div>
              <h1>{page}</h1>
              <p>{descriptions[page]}</p>
            </div>
            {[
              "App content",
              "Templates",
              "Text library",
              "Coins & plans",
            ].includes(page) ? (
              <div className="heading-actions">
                <Badge tone={dirty ? "amber" : "green"}>
                  {dirty ? "Unsaved changes" : "Draft saved"}
                </Badge>
                <Button icon={Save} disabled={busy || !dirty} onClick={save}>
                  Save draft
                </Button>
                <Button
                  icon={Send}
                  variant="primary"
                  disabled={busy || !!dirty || !content}
                  onClick={() => setPublish(true)}
                >
                  Publish
                </Button>
              </div>
            ) : (
              <Button
                icon={RefreshCw}
                disabled={busy}
                onClick={() => setRevision((v) => v + 1)}
              >
                Refresh
              </Button>
            )}
          </div>
          {error && (
            <div role="alert" className="callout danger global-error">
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {screen}
          <footer className="main-footer">
            <span>Genora AI Image &amp; Video Editor</span>
            <span>
              Published version {published?.version || "—"} · Changes go live
              only when published
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div role="status" className="toast">
          <Check size={18} />
          {toast}
        </div>
      )}
      {publish && (
        <Modal title="Publish app content" onClose={() => setPublish(false)}>
          <form onSubmit={publishDraft}>
            <div className="callout">
              <Send size={20} />
              <span>
                This will make your saved draft available to every connected
                app. Coin changes apply to new requests.
              </span>
            </div>
            <div className="release-summary">
              <span>
                {content.templates.filter((t) => t.enabled).length} enabled
                templates
              </span>
              <span>{Object.keys(content.texts).length} text entries</span>
              <span>
                Image: {content.costs.image} coins · Video:{" "}
                {content.costs.video} coins
              </span>
            </div>
            <Field
              label="Release note"
              placeholder="Describe what changed"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              required
              maxLength={300}
            />
            <div className="modal-actions">
              <Button type="button" onClick={() => setPublish(false)}>
                Cancel
              </Button>
              <Button variant="primary" icon={Send} disabled={busy}>
                Publish to app
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function Overview({ revision, onPage }) {
  const [data, error] = useData("/overview", revision);
  if (!data) return <Load error={error} />;
  const stats = [
    ["Total users", data.users, Users, "Registered and guest accounts"],
    [
      "Generations",
      data.jobs,
      Sparkles,
      data.pending + " requests in progress",
    ],
    [
      "Active templates",
      data.templates,
      Layers,
      "Available in the published app",
    ],
    ["Coins in wallets", data.coins, Coins, "Server-managed balances"],
  ];
  return (
    <>
      <section className="welcome-banner">
        <div>
          <Badge tone="blue">YOUR WORKSPACE IS READY</Badge>
          <h2>Bring your app to life.</h2>
          <p>
            Curate the content. Set the rules.
            <br />
            Give every idea a place to start.
          </p>
          <Button
            variant="primary"
            icon={ArrowUpRight}
            onClick={() => onPage("App content")}
          >
            Manage app content
          </Button>
        </div>
        <div className="banner-art">
          <img src="/seed-assets/couple.png" />
          <img src="/seed-assets/flowers.png" />
          <img src="/seed-assets/portrait.png" />
          <div className="floating-label">
            <Sparkles size={16} /> Made for imagination
          </div>
        </div>
      </section>
      <div className="stat-grid">
        {stats.map(([title, value, Icon, subtitle]) => (
          <div className="stat-card" key={title}>
            <div>
              <span>{title}</span>
              <Icon size={19} />
            </div>
            <strong>{fmt(value)}</strong>
            <small>{subtitle}</small>
          </div>
        ))}
      </div>
      <div className="two-columns">
        <Panel
          title="Generation activity"
          description="Real requests from your app"
          action={<Badge>Last 14 active days</Badge>}
        >
          {data.activity.length ? (
            <div className="chart">
              {[...data.activity].reverse().map((item) => (
                <div className="bar-column" key={item.date}>
                  <span>{item.count}</span>
                  <div
                    className="chart-bar"
                    style={{
                      height: Math.max(
                        6,
                        (item.count /
                          Math.max(...data.activity.map((d) => d.count))) *
                        150,
                      ),
                    }}
                  />
                  <small>{item.date.slice(5)}</small>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="Your first creation starts here">
              Activity will appear when a connected AI provider processes
              requests.
            </Empty>
          )}
        </Panel>
        <Panel
          title="Service status"
          description="What is ready behind the scenes"
        >
          <div className="service-list">
            {[
              ["Backend & database", true],
              ["Dynamic content", true],
              ["Image generation", data.services.image],
              ["Video generation", data.services.video],
              ["Google Play billing", data.services.billing],
              ["Rewarded advertising", false],
            ].map(([label, ready]) => (
              <div key={label}>
                <span>
                  <i className={ready ? "status-dot" : "status-dot muted"} />
                  {label}
                </span>
                <Badge tone={ready ? "green" : ""}>
                  {ready ? "Connected" : "Not configured"}
                </Badge>
              </div>
            ))}
          </div>
          <Button
            variant="text"
            icon={ArrowUpRight}
            onClick={() => onPage("Integrations")}
          >
            Manage integrations
          </Button>
        </Panel>
      </div>
      <Panel
        title="Recent workspace activity"
        description="Changes made by your administrators"
        action={
          <Button variant="text" onClick={() => onPage("Audit log")}>
            View all <ArrowUpRight size={15} />
          </Button>
        }
      >
        {data.recent.length ? (
          <div className="activity-list">
            {data.recent.map((item) => (
              <div key={item.id}>
                <div className="activity-icon">
                  <Check size={16} />
                </div>
                <div>
                  <strong>{item.action.replaceAll(".", " · ")}</strong>
                  <small>{item.target}</small>
                </div>
                <time>{date(item.created_at)}</time>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="A fresh start">
            Your first saved change will appear here.
          </Empty>
        )}
      </Panel>
    </>
  );
}

function ContentEditor({ content: c, update }) {
  const set = (section, key, value) =>
    update((d) => {
      d[section][key] = value;
    });
  return (
    <>
      <div className="callout">
        <Eye size={19} />
        <span>
          You are editing a draft. Save your changes, then publish to update the
          app without rebuilding it.
        </span>
      </div>
      <div className="two-columns">
        <Panel
          title="Brand & appearance"
          description="Your app's identity inside the experience"
        >
          <Field
            label="App display name"
            value={c.branding.appName}
            onChange={(e) => set("branding", "appName", e.target.value)}
          />
          <Field
            label="Logo image URL"
            value={c.branding.logoUrl}
            placeholder="/media/… or https://…"
            onChange={(e) => set("branding", "logoUrl", e.target.value)}
            hint="Leave empty to use your original logo. Android launcher name/icon changes require a new build."
          />
          <Field
            label="Accent color"
            type="color"
            value={c.branding.accent}
            onChange={(e) => set("branding", "accent", e.target.value)}
          />
        </Panel>
        <Panel title="Home banner" description="The first invitation to create">
          <Field
            label="Headline"
            value={c.home.title}
            onChange={(e) => set("home", "title", e.target.value)}
          />
          <Field
            label="Description"
            textarea
            value={c.home.subtitle}
            onChange={(e) => set("home", "subtitle", e.target.value)}
          />
          <div className="form-grid">
            <Field
              label="Button label"
              value={c.home.button}
              onChange={(e) => set("home", "button", e.target.value)}
            />
            <Field
              label="Banner image URL"
              value={c.home.bannerUrl}
              onChange={(e) => set("home", "bannerUrl", e.target.value)}
            />
          </div>
        </Panel>
      </div>
      <div className="two-columns">
        <Panel
          title="Collections & home feed"
          description="One item per line. Names must match template categories."
        >
          {Object.entries(c.categories).map(([key, values]) => (
            <Field
              key={key}
              label={key + " categories"}
              textarea
              value={values.join("\n")}
              onChange={(e) =>
                set("categories", key, e.target.value.split("\n"))
              }
            />
          ))}
          <Field
            label="Home section order"
            textarea
            value={c.home.sections.join("\n")}
            onChange={(e) =>
              set("home", "sections", e.target.value.split("\n"))
            }
          />
          <Field
            label="Featured template IDs"
            textarea
            value={c.home.featuredIds.join("\n")}
            onChange={(e) =>
              set(
                "home",
                "featuredIds",
                e.target.value.split("\n").filter(Boolean),
              )
            }
          />
        </Panel>
        <div>
          <Panel
            title="Feature controls"
            description="Turn availability on or off for new requests"
          >
            {Object.entries(c.features).map(([key, value]) => (
              <Toggle
                key={key}
                label={
                  {
                    image: "Image generation",
                    video: "Video generation",
                    dance: "AI Dance",
                    slideshow: "Slideshow templates",
                    dailyRewards: "Daily rewards",
                    ads: "All advertising",
                    bannerAds: "Bottom banner ads",
                    appOpenAds: "Launch ads",
                    interstitialAds: "Back-navigation ads",
                    rewardedAds: "Rewarded coin ads",
                    maintenance: "Maintenance mode",
                  }[key]
                }
                checked={value}
                onChange={(v) => set("features", key, v)}
                hint={
                  key === "maintenance"
                    ? "Stops generation and reward claims. Browsing stays available."
                    : undefined
                }
              />
            ))}
          </Panel>
          <Panel title="Support & announcements">
            <div className="callout">
              Public Play Console links: <a href="/privacy" target="_blank" rel="noreferrer">Privacy policy</a>{" · "}<a href="/terms" target="_blank" rel="noreferrer">Terms</a>{" · "}<a href="/account-deletion" target="_blank" rel="noreferrer">Account deletion</a>
            </div>
            <Field
              label="Support email"
              type="email"
              value={c.legal.supportEmail}
              onChange={(e) => set("legal", "supportEmail", e.target.value)}
            />
            <Field
              label="Google Play app link"
              value={c.legal.playStoreUrl}
              onChange={(e) => set("legal", "playStoreUrl", e.target.value)}
            />
            <Field
              label="Home announcement"
              textarea
              value={c.legal.announcement}
              onChange={(e) => set("legal", "announcement", e.target.value)}
            />
          </Panel>
        </div>
      </div>
      <Panel
        title="Legal content"
        description="Plain text shown on the app's legal screens. Have your final policies reviewed before public launch."
      >
        <div className="form-grid">
          <Field
            label="Privacy policy"
            textarea
            rows={10}
            value={c.legal.privacy}
            onChange={(e) => set("legal", "privacy", e.target.value)}
          />
          <Field
            label="Terms of use"
            textarea
            rows={10}
            value={c.legal.terms}
            onChange={(e) => set("legal", "terms", e.target.value)}
          />
        </div>
      </Panel>
    </>
  );
}
function TemplatesEditor({ content: c, update }) {
  const [q, setQ] = useState(""),
    [filter, setFilter] = useState("all"),
    [editing, setEditing] = useState(null),
    [original, setOriginal] = useState(null);
  const items = c.templates
    .filter(
      (t) =>
        (filter === "all" || t.kind === filter) &&
        (t.title + " " + t.category + " " + t.id)
          .toLowerCase()
          .includes(q.toLowerCase()),
    )
    .sort((a, b) => a.order - b.order);
  function edit(t) {
    setEditing(structuredClone(t));
    setOriginal(t.id);
  }
  function add() {
    setOriginal(null);
    setEditing({
      id: "template-" + crypto.randomUUID().slice(0, 8),
      title: "New template",
      kind: "image",
      category: c.categories.image[0],
      art: "portrait",
      prompt: "Create a natural editorial portrait.",
      imageUrl: "",
      enabled: true,
      order: c.templates.length,
    });
  }
  function apply(e) {
    e.preventDefault();
    if (c.templates.some((t) => t.id === editing.id && t.id !== original))
      return;
    update((d) => {
      if (original)
        d.templates = d.templates.map((t) => (t.id === original ? editing : t));
      else d.templates.push(editing);
      if (original && original !== editing.id)
        d.home.featuredIds = d.home.featuredIds.map((id) =>
          id === original ? editing.id : id,
        );
    });
    setEditing(null);
  }
  return (
    <>
      <div className="toolbar">
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder="Search templates or categories"
        />
        <div className="tabs">
          {["all", "image", "video", "dance", "slideshow"].map((f) => (
            <button
              className={filter === f ? "selected" : ""}
              key={f}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <Button variant="primary" icon={Plus} onClick={add}>
          Add template
        </Button>
      </div>
      <div className="collection-meta">
        <span>{items.length} templates</span>
        <span>Edits are added to your draft</span>
      </div>
      <div className="template-grid">
        {items.map((t) => (
          <article className="template-card" key={t.id}>
            <button
              className="template-cover"
              onClick={() => edit(t)}
              aria-label={"Edit " + t.title}
            >
              <img
                src={t.imageUrl || "/seed-assets/" + t.art + ".png"}
                loading="lazy"
              />
              <Badge tone={t.enabled ? "green" : ""}>
                {t.enabled ? "Enabled" : "Hidden"}
              </Badge>
              <span className="template-kind">
                {t.kind === "slideshow"
                  ? t.count + " photos · " + t.duration + "s"
                  : t.kind}
              </span>
            </button>
            <div className="template-info">
              <span>{t.category}</span>
              <h3>{t.title}</h3>
              <div>
                <small>{t.id}</small>
                <button onClick={() => edit(t)}>
                  Edit template <ArrowUpRight size={14} />
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
      {!items.length && (
        <Empty title="No templates found">
          Try another search or add your first template.
        </Empty>
      )}
      {editing && (
        <Modal
          title={original ? "Edit template" : "New template"}
          wide
          onClose={() => setEditing(null)}
        >
          <form onSubmit={apply}>
            <div className="template-editor">
              <img
                className="editor-preview"
                src={editing.imageUrl || "/seed-assets/" + editing.art + ".png"}
              />
              <div>
                <div className="form-grid">
                  <Field
                    label="Template ID"
                    value={editing.id}
                    required
                    pattern="[a-zA-Z0-9_-]{1,80}"
                    onChange={(e) =>
                      setEditing({ ...editing, id: e.target.value })
                    }
                  />
                  <Field
                    label="Title"
                    value={editing.title}
                    required
                    onChange={(e) =>
                      setEditing({ ...editing, title: e.target.value })
                    }
                  />
                </div>
                <div className="form-grid">
                  <Field label="Type">
                    <select
                      value={editing.kind}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          kind: e.target.value,
                          category:
                            c.categories[
                            e.target.value === "dance"
                              ? "video"
                              : e.target.value
                            ][0],
                          ...(e.target.value === "slideshow"
                            ? { count: 8, duration: 15 }
                            : {}),
                        })
                      }
                    >
                      {["image", "video", "dance", "slideshow"].map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Category">
                    <select
                      value={editing.category}
                      onChange={(e) =>
                        setEditing({ ...editing, category: e.target.value })
                      }
                    >
                      {c.categories[
                        editing.kind === "dance" ? "video" : editing.kind
                      ].map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field
                  label="Preview image URL"
                  value={editing.imageUrl}
                  placeholder="Copy a URL from Media library"
                  onChange={(e) =>
                    setEditing({ ...editing, imageUrl: e.target.value })
                  }
                />
                <Field label="Fallback artwork">
                  <select
                    value={editing.art}
                    onChange={(e) =>
                      setEditing({ ...editing, art: e.target.value })
                    }
                  >
                    {["portrait", "city", "couple", "flowers"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="Generation prompt"
                  textarea
                  rows={5}
                  value={editing.prompt}
                  maxLength={4000}
                  required={editing.kind !== "slideshow"}
                  onChange={(e) =>
                    setEditing({ ...editing, prompt: e.target.value })
                  }
                />
                <div className="form-grid">
                  {editing.kind === "slideshow" && (
                    <>
                      <Field
                        label="Photo count"
                        type="number"
                        min="2"
                        max="30"
                        value={editing.count}
                        required
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            count: Number(e.target.value),
                          })
                        }
                      />
                      <Field
                        label="Duration (seconds)"
                        type="number"
                        min="3"
                        max="120"
                        value={editing.duration}
                        required
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            duration: Number(e.target.value),
                          })
                        }
                      />
                    </>
                  )}
                  <Field
                    label="Display order"
                    type="number"
                    min="0"
                    value={editing.order}
                    onChange={(e) =>
                      setEditing({ ...editing, order: Number(e.target.value) })
                    }
                  />
                </div>
                <Toggle
                  label="Show in app"
                  checked={editing.enabled}
                  onChange={(v) => setEditing({ ...editing, enabled: v })}
                />
                <Toggle label="Premium template (generation still costs coins)" checked={!!editing.premium} onChange={(v) => setEditing({ ...editing, premium: v })} />
              </div>
            </div>
            {c.templates.some(
              (t) => t.id === editing.id && t.id !== original,
            ) && (
                <div className="callout danger">
                  This template ID already exists.
                </div>
              )}
            <div className="modal-actions">
              {original && (
                <Button
                  type="button"
                  variant="danger"
                  icon={Trash2}
                  onClick={() => {
                    update((d) => {
                      d.templates = d.templates.filter(
                        (t) => t.id !== original,
                      );
                      d.home.featuredIds = d.home.featuredIds.filter(
                        (id) => id !== original,
                      );
                    });
                    setEditing(null);
                  }}
                >
                  Remove from draft
                </Button>
              )}
              <Button type="button" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button variant="primary" icon={Check}>
                Apply to draft
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
function TextEditor({ content: c, update }) {
  const [q, setQ] = useState(""),
    [limit, setLimit] = useState(40),
    [key, setKey] = useState("");
  const entries = Object.entries(c.texts).filter(([k, v]) =>
    (k + " " + v).toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <>
      <div className="toolbar">
        <SearchBox
          value={q}
          onChange={(v) => {
            setQ(v);
            setLimit(40);
          }}
          placeholder="Search app labels, buttons, and messages"
        />
        <Badge>{Object.keys(c.texts).length} entries</Badge>
      </div>
      <div className="callout">
        <Type size={19} />
        <span>
          The original text is the stable lookup key. Edit “App text” to change
          what users see. Names, template recipes, and prices have their own
          editors.
        </span>
      </div>
      <Panel
        title="App copy"
        description="Text changes apply to the connected app after publishing"
      >
        <div className="text-table">
          <div className="text-table-header">
            <span>ORIGINAL TEXT / LOOKUP KEY</span>
            <span>APP TEXT</span>
          </div>
          {entries.slice(0, limit).map(([k, v]) => (
            <div className="text-row" key={k}>
              <div>
                <code>{k}</code>
                {k !== v && <Badge tone="blue">Customized</Badge>}
              </div>
              <textarea
                aria-label={"App text: " + k}
                rows={v.length > 120 ? 3 : 2}
                value={v}
                onChange={(e) =>
                  update((d) => {
                    d.texts[k] = e.target.value;
                  })
                }
              />
            </div>
          ))}
        </div>
        {entries.length > limit && (
          <Button onClick={() => setLimit((n) => n + 40)}>
            Load more ({entries.length - limit} remaining)
          </Button>
        )}
        {!entries.length && (
          <Empty title="No matching text">Try a shorter phrase.</Empty>
        )}
      </Panel>
      <Panel
        title="Add a text override"
        description="For a new app label or server message that is not listed yet"
      >
        <div className="inline-form">
          <Field
            label="Exact original text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <Button
            disabled={
              !key.trim() ||
              ["__proto__", "prototype", "constructor"].includes(key)
            }
            icon={Plus}
            onClick={() => {
              update((d) => {
                d.texts[key] = key;
              });
              setQ(key);
              setKey("");
            }}
          >
            Add entry
          </Button>
        </div>
      </Panel>
    </>
  );
}
function EconomyEditor({ content: c, update }) {
  const number = (section, key, value) =>
    update((d) => {
      d[section][key] = Number(value);
    });
  return (
    <>
      <div className="callout">
        <Coins size={19} />
        <span>
          Costs and daily rewards are enforced by the backend. Product labels
          are editable here; actual purchase prices must also be configured in
          Google Play.
        </span>
      </div>
      <div className="two-columns">
        <Panel
          title="Generation costs"
          description="Coins reserved per new request"
        >
          <div className="form-grid">
            {Object.entries(c.costs).map(([k, v]) => (
              <Field
                key={k}
                label={k + " coins"}
                type="number"
                min="0"
                max="1000000"
                value={v}
                onChange={(e) => number("costs", k, e.target.value)}
              />
            ))}
          </div>
        </Panel>
        <Panel
          title="Welcome & completion rewards"
          description="Completion rewards apply once to successful server jobs"
        >
          <div className="form-grid">
            {["welcome", "image", "video", "slideshow"].map((k) => (
              <Field
                key={k}
                label={k + " coins"}
                type="number"
                min="0"
                max="1000000"
                value={c.rewards[k]}
                onChange={(e) => number("rewards", k, e.target.value)}
              />
            ))}
          </div>
        </Panel>
      </div>
      <Panel
        title="Daily check-in"
        description="Seven-day cycle, based on UTC server dates. Missed days restart the cycle."
      >
        <div className="daily-fields">
          {c.rewards.daily.map((v, i) => (
            <Field
              key={i}
              label={"Day " + (i + 1)}
              type="number"
              min="0"
              max="1000000"
              value={v}
              onChange={(e) =>
                update((d) => {
                  d.rewards.daily[i] = Number(e.target.value);
                })
              }
            />
          ))}
        </div>
      </Panel>
      <Panel
        title="Ad & notification reward displays"
        description="Amounts are configurable. Claims stay disabled until provider verification is implemented."
      >
        <div className="form-grid">
          {["ad", "twoAds", "notification"].map((k) => (
            <Field
              key={k}
              label={k + " coins"}
              type="number"
              min="0"
              value={c.rewards[k]}
              onChange={(e) => number("rewards", k, e.target.value)}
            />
          ))}
        </div>
      </Panel>
      <Panel
        title="Coin packs"
        action={
          <Button
            icon={Plus}
            onClick={() =>
              update((d) => {
                d.coinPacks.push({
                  id: "pack-" + crypto.randomUUID().slice(0, 8),
                  coins: 100,
                  rupees: 199,
                  label: "₹199.00",
                  productId: "",
                  enabled: true,
                });
              })
            }
          >
            Add pack
          </Button>
        }
      >
        <div className="product-grid">
          {c.coinPacks.map((p, i) => (
            <div className="product-editor" key={i}>
              <div className="product-heading">
                <Coins size={23} />
                <button
                  aria-label={"Remove coin pack " + p.id}
                  className="icon-button"
                  onClick={() =>
                    update((d) => {
                      d.coinPacks.splice(i, 1);
                    })
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
              {["id", "coins", "rupees", "label", "productId"].map((k) => (
                <Field
                  key={k}
                  label={
                    {
                      id: "Pack ID",
                      coins: "Coins",
                      rupees: "Price in INR",
                      label: "Display price",
                      productId: "Google Play product ID",
                    }[k]
                  }
                  type={["coins", "rupees"].includes(k) ? "number" : "text"}
                  min="0"
                  value={p[k]}
                  onChange={(e) =>
                    update((d) => {
                      d.coinPacks[i][k] = ["coins", "rupees"].includes(k)
                        ? Number(e.target.value)
                        : e.target.value;
                    })
                  }
                />
              ))}
              <Toggle
                label="Show pack"
                checked={p.enabled}
                onChange={(v) =>
                  update((d) => {
                    d.coinPacks[i].enabled = v;
                  })
                }
              />
            </div>
          ))}
        </div>
      </Panel>
      <Panel
        title="Subscription plans"
        action={
          <Button
            icon={Plus}
            onClick={() =>
              update((d) => {
                d.plans.push({
                  id: "plan-" + crypto.randomUUID().slice(0, 8),
                  label: "Monthly",
                  price: "₹999.00",
                  period: "month",
                  saving: "",
                  productId: "",
                  enabled: true,
                });
              })
            }
          >
            Add plan
          </Button>
        }
      >
        <div className="product-grid">
          {c.plans.map((p, i) => (
            <div className="product-editor" key={i}>
              <div className="product-heading">
                <Sparkles size={23} />
                <button
                  aria-label={"Remove plan " + p.id}
                  className="icon-button"
                  onClick={() =>
                    update((d) => {
                      d.plans.splice(i, 1);
                    })
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
              {["id", "label", "price", "period", "saving", "productId", "basePlanId"].map(
                (k) => (
                  <Field
                    key={k}
                    label={
                      {
                        id: "Plan ID",
                        label: "Plan name",
                        price: "Display price",
                        period: "Billing period label",
                        saving: "Savings badge",
                        productId: "Google Play product ID",
                        basePlanId: "Google Play base plan ID",
                      }[k]
                    }
                    value={p[k]}
                    onChange={(e) =>
                      update((d) => {
                        d.plans[i][k] = e.target.value;
                      })
                    }
                  />
                ),
              )}
              <Toggle
                label="Show plan"
                checked={p.enabled}
                onChange={(v) =>
                  update((d) => {
                    d.plans[i].enabled = v;
                  })
                }
              />
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}
function MediaLibrary({ revision, run, busy }) {
  const [data, error] = useData("/media", revision),
    [copied, setCopied] = useState("");
  return (
    <>
      <div className="callout">
        <Image size={19} />
        <span>
          Upload PNG, JPEG, or WebP files up to 30 MB. These are public app
          assets. Users' private input photos are kept separate.
        </span>
      </div>
      <label className="upload-zone">
        <Upload size={30} />
        <strong>{busy ? "Uploading…" : "Choose artwork to upload"}</strong>
        <span>
          Your images become available for templates, branding, and banners.
        </span>
        <input
          aria-label="Upload artwork"
          disabled={busy}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file)
              run(async () => {
                const form = new FormData();
                form.append("file", file);
                await api("/media", "POST", form);
              }, "Artwork uploaded. Copy its URL into your draft.");
            e.target.value = "";
          }}
        />
      </label>
      {!data ? (
        <Load error={error} />
      ) : data.media.length ? (
        <div className="media-grid">
          {data.media.map((m) => (
            <article className="media-card" key={m.id}>
              <img src={m.url} loading="lazy" />
              <div>
                <small>
                  {m.mime} · {(m.bytes / 1024 / 1024).toFixed(2)} MB
                </small>
                <input
                  aria-label="Media URL"
                  readOnly
                  value={m.url}
                  onFocus={(e) => e.target.select()}
                />
                <div className="row">
                  <Button
                    onClick={() =>
                      run(async () => {
                        await navigator.clipboard.writeText(m.url);
                        setCopied(m.id);
                      })
                    }
                  >
                    {copied === m.id ? "Copied" : "Copy URL"}
                  </Button>
                  <button
                    aria-label="Delete unused media"
                    className="icon-button danger-text"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () => api("/media/" + m.id, "DELETE"),
                        "Unused artwork removed.",
                      )
                    }
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty title="Your media library is ready">
          Upload artwork to start building your own collections.
        </Empty>
      )}
      <Panel
        title="Bundled original artwork"
        description="These four originals remain available as template fallbacks."
      >
        <div className="originals">
          {["portrait", "city", "couple", "flowers"].map((name) => (
            <div key={name}>
              <img src={"/seed-assets/" + name + ".png"} />
              <span>{name}</span>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}
function UserManager({ revision, run, busy }) {
  const [q, setQ] = useState(""),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState(null),
    [detail, setDetail] = useState(null),
    [adjust, setAdjust] = useState(false),
    [amount, setAmount] = useState(0),
    [reason, setReason] = useState(""),
    [requestId, setRequestId] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [deleting, setDeleting] = useState(false);
  const [data, error] = useData(
    "/users?q=" + encodeURIComponent(q) + "&page=" + page,
    revision,
  );
  useEffect(() => {
    if (selected)
      api("/users/" + selected)
        .then(setDetail)
        .catch(() => setDetail(null));
  }, [selected, revision]);
  return (
    <>
      <div className="toolbar">
        <SearchBox
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search email or user ID"
        />
        <Badge>{fmt(data?.total)} accounts</Badge>
      </div>
      <Panel
        title="App users"
        description="Balances come from the server ledger"
      >
        {!data ? (
          <Load error={error} />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Status</th>
                    <th>Coins</th>
                    <th>Joined</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <strong>{u.email || "Guest account"}</strong>
                        <small>{u.id}</small>
                      </td>
                      <td>
                        <Badge tone={u.status === "active" ? "green" : "amber"}>
                          {u.status}
                        </Badge>
                      </td>
                      <td>{fmt(u.coins)}</td>
                      <td>{date(u.createdAt)}</td>
                      <td>
                        <Button
                          onClick={() => {
                            setSelected(u.id);
                            setDetail(null);
                          }}
                        >
                          Manage <ChevronRight size={14} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.users.length && (
              <Empty title="No users found">
                Accounts appear when people open the connected app.
              </Empty>
            )}
            <Pager page={page} total={data.total} onPage={setPage} />
          </>
        )}
      </Panel>
      {selected && (
        <Modal
          title="Manage user"
          wide
          onClose={() => {
            setSelected(null);
            setDetail(null);
            setAdjust(false);
            setDeleting(false);
          }}
        >
          {!detail ? (
            <Load />
          ) : (
            <>
              <div className="user-summary">
                <div className="avatar large">
                  {(detail.user.email || "G")[0].toUpperCase()}
                </div>
                <div>
                  <h3>{detail.user.email || "Guest account"}</h3>
                  <code>{detail.user.id}</code>
                  <p>Joined {date(detail.user.createdAt)}</p>
                </div>
                <div className="user-coins">
                  <strong>{fmt(detail.user.coins)}</strong>
                  <span>coins</span>
                </div>
              </div>
              <div className="toolbar">
                <Button
                  icon={Coins}
                  disabled={busy}
                  onClick={() => {
                    setAdjust(!adjust);
                    setRequestId(crypto.randomUUID());
                    setAmount(0);
                    setReason("");
                  }}
                >
                  Adjust coins
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    run(
                      () =>
                        api("/users/" + selected, "PATCH", {
                          status:
                            detail.user.status === "active"
                              ? "suspended"
                              : "active",
                        }),
                      "Account status updated.",
                    )
                  }
                >
                  {detail.user.status === "active"
                    ? "Suspend account"
                    : "Reactivate account"}
                </Button>
                <Button variant="danger" onClick={() => setDeleting(!deleting)}>
                  Delete account
                </Button>
              </div>
              {adjust && (
                <form
                  className="inset"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(async () => {
                      await api("/users/" + selected + "/coins", "POST", {
                        amount: Number(amount),
                        reason,
                        requestId,
                      });
                      setAdjust(false);
                    }, "Coin adjustment recorded.");
                  }}
                >
                  <div className="form-grid">
                    <Field
                      label="Coin adjustment"
                      hint="Use a negative number to remove coins."
                      type="number"
                      min="-1000000"
                      max="1000000"
                      required
                      value={amount}
                      onChange={(e) => {
                        setAmount(e.target.value);
                        setRequestId(crypto.randomUUID());
                      }}
                    />
                    <Field
                      label="Reason (required)"
                      minLength={5}
                      required
                      value={reason}
                      onChange={(e) => {
                        setReason(e.target.value);
                        setRequestId(crypto.randomUUID());
                      }}
                    />
                  </div>
                  <Button
                    variant="primary"
                    disabled={busy || Number(amount) === 0}
                  >
                    Record adjustment
                  </Button>
                </form>
              )}
              {deleting && (
                <form
                  className="inset"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(async () => {
                      await api("/users/" + selected, "DELETE", {
                        confirmation,
                      });
                      setSelected(null);
                      setDeleting(false);
                      setConfirmation("");
                    }, "Account and private media deleted.");
                  }}
                >
                  <p>
                    This permanently removes the user's account, ledger,
                    generations, and private uploads.
                  </p>
                  <Field
                    label="Type DELETE to confirm"
                    value={confirmation}
                    onChange={(e) => setConfirmation(e.target.value)}
                    required
                    pattern="DELETE"
                  />
                  <Button
                    variant="danger"
                    disabled={busy || confirmation !== "DELETE"}
                  >
                    Permanently delete
                  </Button>
                </form>
              )}
              <h3>Coin ledger</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Reason</th>
                      <th>Change</th>
                      <th>Balance</th>
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.ledger.map((l) => (
                      <tr key={l.id}>
                        <td>
                          {l.reason}
                          <small>{l.reference}</small>
                        </td>
                        <td className={l.amount >= 0 ? "positive" : "negative"}>
                          {l.amount > 0 ? "+" : ""}
                          {l.amount}
                        </td>
                        <td>{l.balance}</td>
                        <td>{date(l.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
function Jobs({ revision, run, busy }) {
  const [q, setQ] = useState(""),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState(null);
  const [data, error] = useData(
    "/jobs?q=" + encodeURIComponent(q) + "&page=" + page,
    revision,
  );
  return (
    <>
      <div className="toolbar">
        <SearchBox
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search job ID, user, or status"
        />
      </div>
      <Panel
        title="Generation queue"
        description="Requests persist across server restarts. Failed jobs are refunded once."
      >
        {!data ? (
          <Load error={error} />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>User</th>
                    <th>Status</th>
                    <th>Cost</th>
                    <th>Created</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.jobs.map((j) => (
                    <tr key={j.id}>
                      <td>
                        <strong>{j.mode}</strong>
                        <small>{j.id}</small>
                      </td>
                      <td>
                        <code>{j.userId.slice(0, 12)}…</code>
                      </td>
                      <td>
                        <Badge
                          tone={
                            j.status === "succeeded"
                              ? "green"
                              : j.status === "failed"
                                ? "red"
                                : "amber"
                          }
                        >
                          {j.status}
                        </Badge>
                      </td>
                      <td>{j.cost}</td>
                      <td>{date(j.createdAt)}</td>
                      <td>
                        <Button onClick={() => setSelected(j)}>Details</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.jobs.length && (
              <Empty title="No generations yet">
                Requests will appear when an AI provider is configured and users
                start creating.
              </Empty>
            )}
            <Pager page={page} total={data.total} onPage={setPage} />
          </>
        )}
      </Panel>
      {selected && (
        <Modal title="Generation details" onClose={() => setSelected(null)}>
          <Badge>{selected.status}</Badge>
          <Field label="Prompt" textarea value={selected.prompt} readOnly />
          <dl>
            <dt>Job</dt>
            <dd>{selected.id}</dd>
            <dt>User</dt>
            <dd>{selected.userId}</dd>
            <dt>Coins reserved</dt>
            <dd>{selected.cost}</dd>
            <dt>Provider retries</dt>
            <dd>{selected.attempts}</dd>
          </dl>
          {selected.error && (
            <div className="callout danger">{selected.error}</div>
          )}
          {selected.resultUrl && (
            <a
              className="button"
              href={selected.resultUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open result <ArrowUpRight size={16} />
            </a>
          )}
          {selected.status === "queued" && (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api("/jobs/" + selected.id + "/cancel", "POST", {});
                  setSelected(null);
                }, "Job cancelled and coins refunded.")
              }
            >
              Cancel & refund
            </Button>
          )}
        </Modal>
      )}
    </>
  );
}
function Reports({ revision, run, busy }) {
  const [data, error] = useData("/reports", revision);
  if (!data) return <Load error={error} />;
  return (
    <Panel
      title="Content reports"
      description="Latest 200 submissions from app users"
    >
      {data.reports.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Report</th>
                <th>Reported content</th>
                <th>Submitted</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.reports.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.reason}</strong>
                    <small>{r.detail || "No additional details"}</small>
                  </td>
                  <td>
                    {r.job_id ? (
                      <>
                        <strong>{r.jobMode || "Generation"}</strong>
                        <small>{r.job_id}</small>
                        {r.resultUrl && (
                          <a href={r.resultUrl} target="_blank" rel="noreferrer">
                            Review output <ArrowUpRight size={14} />
                          </a>
                        )}
                      </>
                    ) : (
                      r.template_id || "General"
                    )}
                  </td>
                  <td>{date(r.created_at)}</td>
                  <td>
                    <select
                      aria-label={"Status for report " + r.id}
                      disabled={busy}
                      value={r.status}
                      onChange={(e) =>
                        run(
                          () =>
                            api("/reports/" + r.id, "PATCH", {
                              status: e.target.value,
                            }),
                          "Report updated.",
                        )
                      }
                    >
                      {["open", "reviewing", "resolved"].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="All clear for now">
          Reports from the app will appear here for review.
        </Empty>
      )}
    </Panel>
  );
}
function Purchases({ revision }) {
  const [data, error] = useData("/purchases", revision);
  if (!data) return <Load error={error} />;
  return (
    <>
      <div className="callout">
        <Shield size={20} />
        <span>
          {data.configured ? "Google Play verification is enabled. Coins and premium are granted only after server verification." : "Google Play verification is disabled until its server credentials and products are configured."}
          {data.configured && !data.notificationsReady && " Billing notification authentication still needs configuration."}
        </span>
      </div>
      <Panel title="Purchase history">
        {data.purchases.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Status</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {data.purchases.map((p) => (
                  <tr key={p.id}>
                    <td>{p.product_id}</td>
                    <td>{p.status}</td>
                    <td>{date(p.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No verified purchases">
            Connect Google Play products and server verification before
            accepting payments.
          </Empty>
        )}
      </Panel>
    </>
  );
}
function Releases({ revision, run, busy, draftVersion, dirty, onRestore }) {
  const [data, error] = useData("/revisions", revision),
    [selected, setSelected] = useState(null);
  if (!data) return <Load error={error} />;
  return (
    <>
      <div className="callout">
        <History size={19} />
        <span>
          Restoring a revision replaces the saved draft. Review and publish that
          draft to change the live app.
        </span>
      </div>
      <Panel title="Published versions">
        {data.revisions.map((r, i) => (
          <div className="release-row" key={r.id}>
            <div className="release-marker">
              <History size={20} />
            </div>
            <div>
              <h3>
                Version {r.id} {i === 0 && <Badge tone="green">Live</Badge>}
              </h3>
              <p>{r.note}</p>
              <small>{date(r.created_at)}</small>
            </div>
            <Button disabled={busy || dirty} onClick={() => setSelected(r)}>
              Restore to draft
            </Button>
          </div>
        ))}
      </Panel>
      {dirty && (
        <div className="callout">
          Save your unsaved edits before restoring another revision.
        </div>
      )}
      {selected && (
        <Modal
          title={"Restore version " + selected.id}
          onClose={() => setSelected(null)}
        >
          <p>
            This replaces the saved draft with “{selected.note}”. It does not
            publish automatically.
          </p>
          <div className="modal-actions">
            <Button onClick={() => setSelected(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const d = await api(
                    "/revisions/" + selected.id + "/restore",
                    "POST",
                    { version: draftVersion },
                  );
                  onRestore(d.draft);
                  setSelected(null);
                }, "Revision restored to draft. Review it before publishing.")
              }
            >
              Restore draft
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
function Integrations({ revision, run, busy }) {
  const [data, error] = useData("/integration", revision),
    [settings, setSettings] = useState(null),
    [apiKey, setKey] = useState(""),
    [removeKey, setRemoveKey] = useState(false);
  useEffect(() => {
    if (data)
      setSettings({
        ...(data.provider ? { provider: data.provider } : {}),
        enabled: data.enabled,
        gatewayUrl: data.gatewayUrl,
        models: data.models,
        ...(data.imageSize ? { imageSize: data.imageSize } : {}),
      });
  }, [data]);
  if (!data || !settings) return <Load error={error} />;
  if (data.provider === "fal")
    return (
      <Panel
        title="fal.ai generation"
        description="Choose image quality, edit quality, output shape, and provider cost"
      >
        <div className="callout">
          <Shield size={19} />
          <span>
            {data.hasKey
              ? "API key configured securely on the server."
              : "Add FAL_KEY to the backend environment and restart the server."}
          </span>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () => api("/integration", "PUT", { settings }),
              "Generation settings saved.",
            );
          }}
        >
          <Toggle
            label="Enable AI generation"
            checked={settings.enabled}
            onChange={(enabled) => setSettings({ ...settings, enabled })}
            hint="One result per request, with up to two active generations across the app."
          />
          <div className="form-grid">
            <Field label="Text-to-image model" hint="Controls new images made from a written prompt.">
              <select
                value={settings.models.image}
                onChange={(e) => setSettings({ ...settings, models: { ...settings.models, image: e.target.value } })}
              >
                {data.imageCatalog.image.map((model) => (
                  <option key={model.id} value={model.id}>{model.label} — {model.estimate}</option>
                ))}
              </select>
            </Field>
            <Field label="Photo-editing model" hint="Controls generations that include an uploaded photo.">
              <select
                value={settings.models.edit}
                onChange={(e) => setSettings({ ...settings, models: { ...settings.models, edit: e.target.value } })}
              >
                {data.imageCatalog.edit.map((model) => (
                  <option key={model.id} value={model.id}>{model.label} — {model.estimate}</option>
                ))}
              </select>
            </Field>
            <Field label="New-image shape" hint="Photo edits automatically follow the uploaded image's aspect ratio.">
              <select
                value={settings.imageSize}
                onChange={(e) => setSettings({ ...settings, imageSize: e.target.value })}
              >
                {data.imageSizes.map((size) => <option key={size.id} value={size.id}>{size.label}</option>)}
              </select>
            </Field>
            <Field
              label="Image to video / dance"
              value={data.falModels.video}
              readOnly
            />
            <Field
              label="Text to video"
              value={data.falModels.textVideo}
              readOnly
            />
          </div>
          <h3 className="model-heading">Image model pricing</h3>
          <div className="callout">
            <Shield size={19} />
            <span>
              Pricing route: a prompt without an uploaded photo uses the Text-to-image model.
              Any request containing an uploaded photo uses the Photo-editing model instead.
              FLUX.1 Schnell is never charged for an uploaded-photo edit.
            </span>
          </div>
          <div className="model-options">
            {[...data.imageCatalog.image, ...data.imageCatalog.edit].map((model) => (
              <article className="model-option" key={model.id}>
                <div><strong>{model.label}</strong><Badge tone={model.tier === "Recommended" ? "green" : ""}>{model.tier}</Badge></div>
                <p className="model-price">{model.price}</p>
                <p>{model.description}</p>
                <a href={model.docs} target="_blank" rel="noreferrer">Official fal.ai documentation ↗</a>
              </article>
            ))}
          </div>
          <p className="muted-copy">Provider prices checked {data.pricingChecked}. Charges are estimates and are paid from your fal.ai balance; verify official pricing before changing your customer coin costs.</p>
          <p>
            Images: PNG in the selected aspect ratio. Photo edits preserve the source shape. Videos: 720p MP4, requested duration 5.4 seconds,
            without generated audio. The provider may return a different duration or resolution.
          </p>
          <p>
            Uploaded images are stored privately in R2. fal receives a temporary
            image link. Completed results are copied back to R2 and saved in
            generation history.
          </p>
          <p className="muted-copy">
            Dance uses prompt-guided motion; exact choreography is not
            guaranteed. Multi-photo slideshows are not supported by this
            provider. App coins are separate from your fal credit balance.
          </p>
          <Button variant="primary" icon={Save} disabled={busy}>
            Save settings
          </Button>
        </form>
      </Panel>
    );
  return (
    <>
      <div className="integration-cards">
        {[
          ["AI generation", Plug, data.enabled ? "Configured" : "Awaiting API"],
          ["Google Play billing", Coins, data.billing === "configured" ? "Configured" : "Not configured"],
          ["Rewarded ads", Eye, data.ads === "enabled" ? "Configured" : "Disabled"],
        ].map(([name, Icon, state]) => (
          <div className="integration-card" key={name}>
            <Icon size={25} />
            <h3>{name}</h3>
            <Badge tone={state === "Configured" ? "green" : ""}>{state}</Badge>
          </div>
        ))}
      </div>
      <Panel
        title="AI gateway"
        description="Provider-neutral job interface. Your chosen AI service will be connected through this adapter."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await api("/integration", "PUT", {
                settings,
                ...(apiKey ? { apiKey } : {}),
                removeKey,
              });
              setKey("");
              setRemoveKey(false);
            }, "Integration settings saved securely.");
          }}
        >
          <div className="callout">
            <Shield size={19} />
            <span>
              Secrets are encrypted on the server and never sent to the app.
              Leave the API key blank to keep the saved key.
            </span>
          </div>
          <Toggle
            label="Enable generation provider"
            checked={settings.enabled}
            onChange={(v) => setSettings({ ...settings, enabled: v })}
            hint="Requires a configured gateway URL, key, and model names."
          />
          <Field
            label="Gateway base URL"
            type="url"
            placeholder="https://your-gateway.example.com/v1"
            value={settings.gatewayUrl}
            onChange={(e) =>
              setSettings({ ...settings, gatewayUrl: e.target.value })
            }
            hint={
              "Server hostname allowlist: " +
              (data.allowedHosts ||
                "None yet. Set AI_ALLOWED_HOSTS when the provider is chosen.")
            }
          />
          <Field
            label="API key"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(e) => setKey(e.target.value)}
            placeholder={
              data.hasKey
                ? "A key is saved · enter a new key to replace it"
                : "No key saved yet"
            }
          />
          {data.hasKey && (
            <Toggle
              label="Remove saved API key"
              checked={removeKey}
              onChange={setRemoveKey}
            />
          )}
          <div className="form-grid">
            {Object.entries(settings.models).map(([mode, value]) => (
              <Field
                key={mode}
                label={mode + " model / route"}
                value={value}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    models: { ...settings.models, [mode]: e.target.value },
                  })
                }
              />
            ))}
          </div>
          <Button variant="primary" icon={Save} disabled={busy}>
            Save integration
          </Button>
        </form>
      </Panel>
      <Panel
        title="Connection contract"
        description="Ready for the provider and API key you will supply later"
      >
        <ol className="instructions">
          <li>
            The gateway accepts <code>POST /jobs</code> with a model, prompt,
            mode, and input images.
          </li>
          <li>
            It honors <code>Idempotency-Key</code> to avoid duplicate provider
            charges after a retry.
          </li>
          <li>
            It returns a job ID. The backend checks <code>GET /jobs/:id</code>{" "}
            until a result or failure is available.
          </li>
          <li>
            Successful results use an HTTPS media URL. Failed jobs receive one
            coin refund.
          </li>
        </ol>
        <p className="muted-copy">
          Provider-specific mappings, Google Play verification, and ad callback
          verification require the corresponding accounts and service details.
          They remain disabled until connected and tested.
        </p>
      </Panel>
    </>
  );
}
function AuditLog({ revision }) {
  const [page, setPage] = useState(1),
    [data, error] = useData("/audit?page=" + page, revision);
  return (
    <Panel
      title="Administrative activity"
      description="Secrets and raw provider responses are excluded from this log"
    >
      {!data ? (
        <Load error={error} />
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Target / details</th>
                  <th>Actor</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <Badge>{e.action}</Badge>
                    </td>
                    <td>
                      <code>{e.target}</code>
                      <small>{e.detail !== "{}" ? e.detail : ""}</small>
                    </td>
                    <td>
                      <code>{e.actor.slice(0, 12)}</code>
                    </td>
                    <td>{date(e.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} total={data.total} size={50} onPage={setPage} />
        </>
      )}
    </Panel>
  );
}
function Security({ run, busy }) {
  const [currentPassword, setCurrent] = useState(""),
    [newPassword, setNew] = useState(""),
    [repeat, setRepeat] = useState("");
  return (
    <div className="two-columns">
      <Panel
        title="Change administrator password"
        description="Changing your password signs out other admin sessions."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await api("/password", "POST", { currentPassword, newPassword });
              setCurrent("");
              setNew("");
              setRepeat("");
            }, "Administrator password changed.");
          }}
        >
          <Field
            label="Current password"
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(e) => setCurrent(e.target.value)}
          />
          <Field
            label="New password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            value={newPassword}
            onChange={(e) => setNew(e.target.value)}
            hint="At least 12 characters."
          />
          <Field
            label="Repeat new password"
            type="password"
            autoComplete="new-password"
            required
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
          {repeat && repeat !== newPassword && (
            <p className="negative">Passwords do not match.</p>
          )}
          <Button
            variant="primary"
            disabled={busy || repeat !== newPassword}
            icon={Shield}
          >
            Update password
          </Button>
        </form>
      </Panel>
      <Panel title="Workspace protection">
        <div className="service-list">
          {[
            "Hashed passwords",
            "HttpOnly admin sessions",
            "CSRF-protected changes",
            "Encrypted provider credentials",
            "Versioned content publishing",
            "Audited coin adjustments",
          ].map((label) => (
            <div key={label}>
              <span>{label}</span>
              <Check size={18} className="positive" />
            </div>
          ))}
        </div>
        <p className="muted-copy">
          This local dashboard is bound to this PC. Public deployment needs
          HTTPS, protected database/media backups, and a configured server
          domain.
        </p>
      </Panel>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<Dashboard />);
