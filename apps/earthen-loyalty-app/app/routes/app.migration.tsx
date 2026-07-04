import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const batches = await db.bonMigrationBatch.findMany({
    where: { shopDomain: session.shop },
    orderBy: { createdAt: "desc" },
    take: 10,
    include: {
      rows: {
        where: { error: { not: null } },
        take: 25,
        orderBy: { rowIndex: "asc" },
      },
    },
  });

  return {
    batches: batches.map((batch) => ({
      id: batch.id,
      sourceFileName: batch.sourceFileName,
      status: batch.status,
      sourceRowCount: batch.sourceRowCount,
      validRowCount: batch.validRowCount,
      invalidRowCount: batch.invalidRowCount,
      totalSourcePoints: batch.totalSourcePoints,
      totalImportedPoints: batch.totalImportedPoints,
      importedAt: batch.importedAt?.toISOString() ?? null,
      errors: batch.rows.map((row) => ({
        rowIndex: row.rowIndex,
        email: row.email,
        phone: row.phone,
        shopifyCustomerId: row.shopifyCustomerId,
        points: row.points,
        error: row.error,
      })),
    })),
  };
};

export default function MigrationPage() {
  const data = useLoaderData<typeof loader>();

  const errorRows = data.batches.flatMap((batch) =>
    batch.errors.map((row) => ({ ...row, batchId: batch.id })),
  );

  return (
    <s-page heading="BON migration">
      <s-section heading="Import batches">
        {data.batches.length > 0 ? (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">File</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header format="numeric">Valid rows</s-table-header>
              <s-table-header format="numeric">Imported points</s-table-header>
              <s-table-header>Imported at</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.batches.map((batch) => (
                <s-table-row key={batch.id}>
                  <s-table-cell>{batch.sourceFileName}</s-table-cell>
                  <s-table-cell>
                    <s-badge
                      tone={batch.status === "processed" ? "success" : "warning"}
                    >
                      {batch.status}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {batch.validRowCount}/{batch.sourceRowCount}
                  </s-table-cell>
                  <s-table-cell>
                    {batch.totalImportedPoints}/{batch.totalSourcePoints}
                  </s-table-cell>
                  <s-table-cell>{batch.importedAt ?? "Not imported"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <s-paragraph>No migration batches found.</s-paragraph>
        )}
      </s-section>

      <s-section heading="Rows needing review">
        {errorRows.length > 0 ? (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header format="numeric" listSlot="primary">
                Row
              </s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header format="numeric">Points</s-table-header>
              <s-table-header>Error</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {errorRows.map((row) => (
                <s-table-row key={`${row.batchId}-${row.rowIndex}`}>
                  <s-table-cell>{row.rowIndex}</s-table-cell>
                  <s-table-cell>
                    {row.shopifyCustomerId || row.email || row.phone || "Unknown"}
                  </s-table-cell>
                  <s-table-cell>{row.points ?? ""}</s-table-cell>
                  <s-table-cell>{row.error}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <s-paragraph>No migration row errors are currently recorded.</s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
