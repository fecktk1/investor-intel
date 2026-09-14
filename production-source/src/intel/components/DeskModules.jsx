import React from 'react'
import { orderedKeys } from './DisplayOptions'

export const DESK_MODULES = [['context', 'Market context'], ['positions', 'Your positions'], ['changes', 'Changes since your visit'], ['calendar', 'Next 72 hours'], ['moves', 'Notable moves'], ['overview', 'Workspace overview'], ['chains', 'Chains you follow'], ['personal', 'For you'], ['holdings', 'Signals for your holdings'], ['followed', 'Followed signals'], ['news', 'News and signal radar'], ['research', 'Alerts, briefs and research']]
export function DeskModule({ children, moduleId }) { return <div data-desk-module={moduleId}>{children}</div> }
// Keep fragment ancestry for fixed controls. Module identity belongs to its semantic id,
// independent of array position or nesting, so React can safely move the existing node.
const flatten = (children, prefix = '') => React.Children.toArray(children).flatMap((child, index) => {
  const key = `${prefix}/${child?.key ?? index}`
  return child?.type === React.Fragment ? flatten(child.props.children, key) : [React.isValidElement(child) ? React.cloneElement(child, { key }) : child]
})
export default function DeskModules({ children, order, visible }) {
  const rows = flatten(children), keys = orderedKeys(DESK_MODULES, order), shown = new Set(visible || keys)
  const modules = rows.filter(row => row?.type === DeskModule), fixed = rows.filter(row => row?.type !== DeskModule)
  return <>{fixed}<div className="intel-desk-modules">{keys.filter(key => shown.has(key)).map(key => {
    const module = modules.find(row => row.props.moduleId === key)
    return module ? React.cloneElement(module, { key: `module-${key}` }) : null
  })}</div></>
}
