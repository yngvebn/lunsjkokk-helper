/**
 * Read-only client for the Lunsjkokkene WPGraphQL endpoint.
 *
 * No auth needed for anything in here — menus, closed days and the product catalogue
 * are all public. Introspection is disabled, so these queries were recovered from the
 * site's own JS bundles; see docs/api-recon.md.
 *
 * Cloudflare sits in front of the endpoint and rejects some HTTP clients on TLS
 * fingerprint alone (Python's urllib gets `error code: 1010`). Node's fetch and curl
 * are fine. If you port this, check that first before debugging the query.
 */

export const GRAPHQL_ENDPOINT = 'https://lunsjkokkene.wpenginepowered.com/index.php?graphql';
export const SITE = 'https://lunsjkokkene.no';

export async function gql(query, variables = {}, { endpoint = GRAPHQL_ENDPOINT, headers = {} } = {}) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: SITE, ...headers },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`GraphQL HTTP ${res.status}: ${body}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 500)}`);
  return json.data;
}

const WEEKLY_MENU = `
query GetCustomWeeklyMenu($selectedDate: String) {
  customWeeklyMenus(selectedDate: $selectedDate) {
    id title fraDato tilDato
    menuItems { productId dag beskrivelse allergier co2 co2Stor kalorier kalorierStor }
  }
}`;

const CLOSED_DAYS = `
query GetClosedDays {
  instillinger { stengteDager { stengteDager { stengtDag meldingIBestillingsmeny } } }
}`;

const PRODUCT_FIELDS = `
  name regularPrice excerpt restrictedToCompanies
  produktTilgjengelighet { availabilityType fradato tildato weekdays }
  minimumsKvantitet { harMinimumskvantitet kvantitet }
  produkt { allergener { nodes { ... on Allergen { title } } } }
  productCategories { nodes { name slug } }`;

const PRODUCTS = `
query GetProducts($first: Int = 100, $after: String) {
  products(first: $first, after: $after, where: {orderby: {field: MENU_ORDER, order: ASC}}) {
    pageInfo { hasNextPage endCursor }
    nodes {
      databaseId menuOrder __typename
      image { mediaItemUrl altText }
      ... on SimpleProduct { ${PRODUCT_FIELDS} c02 kalorier }
      ... on VariableProduct {
        ${PRODUCT_FIELDS}
        variations { nodes { databaseId name regularPrice c02 kalorier restrictedToCompanies } }
      }
    }
  }
  productCategories(first: 100, where: {hideEmpty: true}) {
    nodes { name slug databaseId menuOrder count }
  }
}`;

/** The Mon–Fri weekly menu covering `date`. Returns null when nothing is published. */
export async function fetchWeeklyMenu(date) {
  const data = await gql(WEEKLY_MENU, { selectedDate: date });
  return data.customWeeklyMenus?.[0] ?? null;
}

/** Closed days as [{ date: 'YYYY-MM-DD', message }]. */
export async function fetchClosedDays() {
  const data = await gql(CLOSED_DAYS);
  const raw = data.instillinger?.stengteDager?.stengteDager ?? [];
  return raw
    .filter((d) => d?.stengtDag)
    .map((d) => ({ date: String(d.stengtDag).slice(0, 10), message: d.meldingIBestillingsmeny ?? null }));
}

/** Every product the site shows, plus the category list with its display order. */
export async function fetchCatalogue() {
  const nodes = [];
  let categories = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const data = await gql(PRODUCTS, { first: 100, after });
    nodes.push(...data.products.nodes);
    if (page === 0) categories = data.productCategories.nodes;
    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
  }
  return { products: nodes, categories };
}
