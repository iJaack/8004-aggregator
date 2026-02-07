export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

export async function graphQlRequest<TData>(
  url: string,
  query: string,
  variables: Record<string, unknown>
): Promise<TData> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GraphQL HTTP ${res.status} ${res.statusText}: ${body}`);
  }

  const json = (await res.json()) as GraphQLResponse<TData>;
  if (json.errors?.length) {
    throw new Error(
      `GraphQL errors: ${json.errors.map((e) => e.message ?? "unknown").join("; ")}`
    );
  }
  if (!json.data) throw new Error("GraphQL response missing data");
  return json.data;
}

