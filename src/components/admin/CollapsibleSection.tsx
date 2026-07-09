import { useState, type ReactNode } from 'react';

/** Accordion section for the Admin page. `tone="warn"` gives the guarded look used for
 *  the one-time setup / advanced controls. */
export function CollapsibleSection({
  title,
  subtitle,
  icon,
  defaultOpen = false,
  tone = 'default',
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: string;
  defaultOpen?: boolean;
  tone?: 'default' | 'warn';
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`admin-collapsible ${tone === 'warn' ? 'admin-collapsible-warn' : ''}`}>
      <button
        className="admin-collapsible-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="admin-collapsible-title">
          {icon && <span className="admin-collapsible-icon">{icon}</span>}
          <span>
            {title}
            {subtitle && <span className="admin-collapsible-sub"> — {subtitle}</span>}
          </span>
        </span>
        <span className={`admin-chevron ${open ? 'open' : ''}`}>▸</span>
      </button>
      {open && <div className="admin-collapsible-body">{children}</div>}
    </div>
  );
}
