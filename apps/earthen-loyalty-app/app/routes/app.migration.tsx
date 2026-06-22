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

  return (
    <s-page heading="BON migration">
      <s-section heading="Import batches">
        {data.batches.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Batch</th>
                <th>File</th>
                <th>Status</th>
                <th>Rows</th>
                <th>Imported points</th>
                <th>Imported at</th>
              </tr>
            </thead>
            <tbody>
              {data.batches.map((batch) => (
                <tr key={batch.id}>
                  <td>{batch.id}</td>
                  <td>{batch.sourceFileName}</td>
                  <td>{batch.status}</td>
                  <td>
                    {batch.validRowCount}/{batch.sourceRowCount} valid
                  </td>
                  <td>
                    {batch.totalImportedPoints}/{batch.totalSourcePoints}
                  </td>
                  <td>{batch.importedAt ?? "Not imported"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <s-paragraph>No migration batches found.</s-paragraph>
        )}
      </s-section>

      <s-section heading="Rows needing review">
        {data.batches.flatMap((batch) => batch.errors).length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Row</th>
                <th>Customer</th>
                <th>Points</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {data.batches.flatMap((batch) =>
                batch.errors.map((row) => (
                  <tr key={`${batch.id}-${row.rowIndex}`}>
                    <td>{row.rowIndex}</td>
                    <td>
                      {row.shopifyCustomerId || row.email || row.phone || "Unknown"}
                    </td>
                    <td>{row.points ?? ""}</td>
                    <td>{row.error}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
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
