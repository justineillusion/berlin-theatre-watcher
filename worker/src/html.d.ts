// app.html est importé comme texte (règle par défaut de wrangler pour **/*.html).
declare module "*.html" {
  const text: string;
  export default text;
}
