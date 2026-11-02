export function Field({ label, ...inputProps }) {
  return <label className="field-group"><span>{label}</span><input {...inputProps} /></label>;
}
