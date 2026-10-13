export function Panel({ index, title, children }) {
  return <section className="panel"><div className="panel-heading"><div><span className="section-index">{index}</span><h2>{title}</h2></div></div>{children}</section>;
}
