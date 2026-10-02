import { useEffect, useMemo, useState } from 'react'
import { useSession } from '../views/SessionView'
import { baseName } from '../lib'
import { changeRadar, radarCount, type RadarItem } from '../radar'
import { Icon, Section } from '../components/ui'
import { tr } from '../../../shared/i18n'

type DepCheck = { name: string; version: string; ecosystem: string; license?: string; vulns: { id: string; summary?: string }[]; error?: string }

/** Risky kinds of change as they happen: dependencies, env vars, config, migrations, contracts, secrets. */
export function RadarCard() {
  const { tab, s, openDiff } = useSession()
  const radar = useMemo(() => changeRadar(s, tab.cwd), [s.files, s.toolCalls, tab.cwd])
  const [checks, setChecks] = useState<DepCheck[]>([])
  const depKey = radar.dependencies.map((d) => `${d.ecosystem}:${d.name}@${d.version}`).join('|')

  useEffect(() => {
    if (!radar.dependencies.length) return setChecks([])
    let stale = false
    void window.glassbox.radar(radar.dependencies).then((c) => !stale && setChecks(c))
    return () => {
      stale = true
    }
  }, [depKey])

  const open = (file: string) => openDiff({ path: `${s.git?.root ?? tab.cwd}/${file}`, base: null, diffMode: 'merge-base', source: 'session' })
  const count = radarCount(radar)

  // New dependencies, environment variables, config, migrations, contract changes and anything that
  // looks like a secret show up here; with none, the section isn't shown.
  if (count === 0) return null
  return (
    <Section id="risky" title={tr('radarCard.title')} meta={<span className="count">{count}</span>}>

      {radar.secrets.length > 0 && (
        <Group icon="key" tone="err" title={tr('radarCard.secrets')}>
          {radar.secrets.map((x, i) => <Row key={i} x={x} onOpen={open} />)}
        </Group>
      )}
      {radar.dependencies.length > 0 && (
        <Group icon="package" title={tr('radarCard.dependencies')}>
          {radar.dependencies.map((d) => {
            const c = checks.find((x) => x.name === d.name && x.ecosystem === d.ecosystem)
            return (
              <div key={`${d.ecosystem}:${d.name}`} className="radar-row" onClick={() => open(d.file)} title={`${d.file}\n${c?.vulns.map((v) => `${v.id}: ${v.summary ?? ''}`).join('\n') ?? ''}`}>
                <span className="mono small grow ellipsis">
                  {d.name}@{d.version}
                </span>
                <span className="muted small">{d.ecosystem}</span>
                {c?.license && <span className="tag">{c.license}</span>}
                {c ? (
                  c.vulns.length ? (
                    <span className="tag warn-tag">{tr('radarCard.vulnerabilities', { count: c.vulns.length })}</span>
                  ) : c.error ? (
                    <span className="muted small" title={c.error}>{tr('radarCard.notChecked')}</span>
                  ) : (
                    <span className="small ok">{tr('radarCard.noKnownIssues')}</span>
                  )
                ) : (
                  <span className="muted small">{tr('radarCard.checking')}</span>
                )}
              </div>
            )
          })}
        </Group>
      )}
      {radar.envVars.length > 0 && (
        <Group icon="symbol-variable" title={tr('radarCard.envVars')}>
          {radar.envVars.map((x, i) => <Row key={i} x={x} onOpen={open} mono />)}
        </Group>
      )}
      {radar.migrations.length > 0 && (
        <Group icon="database" tone="warn" title={tr('radarCard.migrations')}>
          {radar.migrations.map((x, i) => <Row key={i} x={x} onOpen={open} />)}
        </Group>
      )}
      {radar.contracts.length > 0 && (
        <Group icon="symbol-interface" tone="warn" title={tr('radarCard.contracts')}>
          {radar.contracts.map((x, i) => <Row key={i} x={x} onOpen={open} />)}
        </Group>
      )}
      {radar.config.length > 0 && (
        <Group icon="settings-gear" title={tr('radarCard.config')}>
          {radar.config.map((x, i) => <Row key={i} x={x} onOpen={open} />)}
        </Group>
      )}
    </Section>
  )
}

function Group({ icon, title, tone, children }: { icon: string; title: string; tone?: 'warn' | 'err'; children: React.ReactNode }) {
  return (
    <div className="radar-group">
      <div className="radar-title small">
        <Icon name={icon} className={tone ?? 'muted'} /> {title}
      </div>
      {children}
    </div>
  )
}

function Row({ x, onOpen, mono }: { x: RadarItem; onOpen: (file: string) => void; mono?: boolean }) {
  return (
    <div className="radar-row" onClick={() => onOpen(x.file)} title={x.file}>
      <span className={mono ? 'mono small grow ellipsis' : 'small grow ellipsis'}>{mono ? x.detail : baseName(x.file)}</span>
      <span className="muted small ellipsis">{mono ? baseName(x.file) : x.detail}</span>
    </div>
  )
}
