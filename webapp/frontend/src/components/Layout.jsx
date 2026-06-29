import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  BarChart3, Search, Images, PenTool, Upload,
  Brain, Package, Zap, ChevronLeft, Menu,
  Home, Rocket, Settings, Users, Bell,
  FolderOpen, ChevronDown, ChevronRight,
  Sun, Moon, CreditCard,
} from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import './Layout.css'

/* ---- Logo SVG ---- */
const Logo = () => (
  <svg width="32" height="32" viewBox="0 0 32 32" className="logo-svg">
    <defs>
      <linearGradient id="logo-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#7c5cfc" />
        <stop offset="100%" stopColor="#06b6d4" />
      </linearGradient>
    </defs>
    <path d="M16 2L28 9v14l-12 7L4 23V9z" fill="url(#logo-grad)" opacity="0.9" />
    <circle cx="16" cy="16" r="6" fill="none" stroke="white" strokeWidth="1.5" />
    <circle cx="16" cy="16" r="2" fill="white" />
  </svg>
)

/* ---- Top navbar tabs ---- */
const TOP_TABS = [
  { to: '/dashboard', label: 'Home' },
  { to: '/annotator', label: 'Annotate' },
  { to: '/training', label: 'Train' },
  { to: '/demo', label: 'Deploy' },
  { to: '/models', label: 'Models' },
  { to: '/api-docs', label: 'Analytics' },
]

/* ---- Sidebar nav items ---- */
const SIDEBAR_NAV = [
  { to: '/dashboard', icon: Home, label: 'Home' },
  { to: '/projects', icon: FolderOpen, label: 'Projects' },
  { to: '/dataset', icon: Images, label: 'Datasets' },
  { to: '/annotator', icon: PenTool, label: 'Annotate' },
  { to: '/training', icon: Brain, label: 'Train' },
  { to: '/demo', icon: Rocket, label: 'Deploy' },
  { to: '/models', icon: Package, label: 'Models' },
  { to: '/api-docs', icon: BarChart3, label: 'Analytics' },
  { to: '/import', icon: Upload, label: 'Import' },
]

const SIDEBAR_BOTTOM_NAV = [
  { to: '/settings', icon: Settings, label: 'Settings' },
  { to: '/team', icon: Users, label: 'Team' },
]

/* ---- Project tree items ---- */
const PROJECT_TREE = [
  {
    label: 'Annotate',
    icon: FolderOpen,
    children: [
      { label: 'Object Detection', to: '/annotator' },
      { label: 'Segmentation', to: '/annotator' },
    ],
  },
  {
    label: 'Train',
    icon: FolderOpen,
    children: [
      { label: 'YOLOv8 - Production', to: '/training' },
      { label: 'ResNet - Staging', to: '/training' },
    ],
  },
  {
    label: 'Deploy',
    icon: Rocket,
    children: [
      { label: 'API v2.1 - Active', to: '/models' },
    ],
  },
]

/* ---- Collapsible tree node ---- */
function TreeNode({ item, collapsed: sidebarCollapsed }) {
  const [open, setOpen] = useState(false)
  const Icon = item.icon
  if (sidebarCollapsed) return null
  return (
    <div className="tree-node">
      <button className="tree-toggle" onClick={() => setOpen(o => !o)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Icon size={16} />
        <span>{item.label}</span>
      </button>
      {open && (
        <div className="tree-children">
          {item.children.map((child, i) => (
            <NavLink key={i} to={child.to} className="tree-child-link">
              {child.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---- User dropdown ---- */
function UserDropdown({ show, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!show) return
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [show, onClose])

  if (!show) return null
  return (
    <div className="user-dropdown" ref={ref}>
      <div className="dropdown-header">
        <div className="dropdown-avatar">OT</div>
        <div>
          <div className="dropdown-name">Operator</div>
          <div className="dropdown-email">rapinmeekhian@gmail.com</div>
        </div>
      </div>
      <div className="dropdown-divider" />
      <button className="dropdown-item">Profile</button>
      <button className="dropdown-item">Preferences</button>
      <div className="dropdown-divider" />
      <button className="dropdown-item dropdown-item-danger">Sign Out</button>
    </div>
  )
}

/* ---- Main Layout ---- */
export default function Layout() {
  const [collapsed, setCollapsed] = useState(false)
  const [darkMode, setDarkMode] = useState(true)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  return (
    <div className={`app-layout ${collapsed ? 'sidebar-collapsed' : ''} ${darkMode ? 'dark' : 'light'}`}>
      {/* ===== TOP NAVBAR ===== */}
      <header className="topbar">
        <div className="topbar-left">
          <Logo />
          <span className="topbar-brand">AI-JIN</span>
          <span className="topbar-brand-sub">Platform</span>
        </div>

        <nav className="topbar-center">
          {TOP_TABS.map(({ to, label }) => (
            <NavLink
              key={to + label}
              to={to}
              className={({ isActive }) => `topbar-tab ${isActive ? 'topbar-tab-active' : ''}`}
            >
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="topbar-right">
          <button className="topbar-icon-btn" title="Notifications">
            <Bell size={18} />
            <span className="notif-badge">3</span>
          </button>
          <button className="topbar-icon-btn" title="Settings" onClick={() => navigate('/settings')}>
            <Settings size={18} />
          </button>
          <div className="topbar-user-wrap">
            <button
              className="topbar-avatar"
              onClick={() => setShowUserMenu(v => !v)}
            >
              OT
            </button>
            <UserDropdown show={showUserMenu} onClose={() => setShowUserMenu(false)} />
          </div>
        </div>
      </header>

      {/* ===== LEFT SIDEBAR ===== */}
      <aside className="sidebar">
        {/* Search */}
        <div className="sidebar-search-wrap">
          {collapsed ? (
            <button className="sidebar-search-icon-btn">
              <Search size={18} />
            </button>
          ) : (
            <div className="sidebar-search">
              <Search size={15} className="search-icon" />
              <input type="text" placeholder="Search..." readOnly />
              <kbd className="search-kbd">&#8984;K</kbd>
            </div>
          )}
        </div>

        {/* Projects section */}
        {!collapsed && (
          <div className="sidebar-section">
            <div className="sidebar-section-title">My Projects</div>
            {PROJECT_TREE.map((item, i) => (
              <TreeNode key={i} item={item} collapsed={collapsed} />
            ))}
          </div>
        )}

        <div className="sidebar-divider" />

        {/* Main nav */}
        <nav className="sidebar-nav">
          {SIDEBAR_NAV.map(({ to, icon: Icon, label }) => (
            <NavLink key={to + label} to={to} className="nav-link">
              <Icon size={20} />
              {!collapsed && <span>{label}</span>}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-divider" />

        {/* Bottom nav */}
        <nav className="sidebar-nav sidebar-nav-bottom">
          {SIDEBAR_BOTTOM_NAV.map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to} className="nav-link">
              <Icon size={20} />
              {!collapsed && <span>{label}</span>}
            </NavLink>
          ))}
        </nav>

        {/* Credits / plan info */}
        {!collapsed && (
          <div className="sidebar-credits">
            <div className="credits-header">
              <CreditCard size={14} />
              <span className="credits-plan-badge">Pro Plan</span>
            </div>
            <div className="credits-bar-wrap">
              <div className="credits-bar">
                <div className="credits-bar-fill" style={{ width: '42.5%' }} />
              </div>
              <span className="credits-text">4,250 / 10,000</span>
            </div>
            <span className="credits-renew">Renews in 12 days</span>
          </div>
        )}

        {/* Footer controls */}
        <div className="sidebar-footer">
          <button
            className="sidebar-toggle-theme"
            onClick={() => setDarkMode(d => !d)}
            title={darkMode ? 'Light mode' : 'Dark mode'}
          >
            {darkMode ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button className="collapse-btn" onClick={() => setCollapsed(c => !c)}>
            {collapsed ? <Menu size={18} /> : <ChevronLeft size={18} />}
          </button>
        </div>

        {/* User info */}
        {!collapsed && (
          <div className="sidebar-user">
            <div className="sidebar-user-avatar">OT</div>
            <div className="sidebar-user-info">
              <div className="sidebar-user-name">Operator</div>
              <div className="sidebar-user-email">rapinmeekhian@gmail.com</div>
            </div>
          </div>
        )}
      </aside>

      {/* ===== MAIN CONTENT ===== */}
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  )
}
