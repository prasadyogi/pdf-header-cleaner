import { issueSignedToken } from "@vercel/blob";
import { handleUploadPresigned, type HandleUploadPresignedBody } from "@vercel/blob/client";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// Vercel Functions cap inbound request bodies at 4.5 MB, so files above that
// must go straight from the browser to Blob storage instead of through
// /api/convert. This route only ever hands out a short-lived signed upload
// token (and gets notified once the upload finishes) -- it never sees file
// bytes.
//
// Uses the presigned-URL flow (issueSignedToken + handleUploadPresigned)
// rather than the classic handleUpload/generateClientTokenFromReadWriteToken
// flow: this project's Blob store is connected via OIDC (no static
// BLOB_READ_WRITE_TOKEN was issued), and generateClientTokenFromReadWriteToken
// requires exactly that static token -- issueSignedToken is the OIDC-native
// equivalent (authenticates with VERCEL_OIDC_TOKEN + BLOB_STORE_ID instead).
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const body = (await req.json()) as HandleUploadPresignedBody;

  try {
    const jsonResponse = await handleUploadPresigned({
      body,
      request: req,
      getSignedToken: async (pathname) => {
        if (!pathname.toLowerCase().endsWith(".pdf")) {
          throw new Error("Only .pdf files can be uploaded.");
        }
        const token = await issueSignedToken({
          pathname,
          operations: ["put"],
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
        });
        return {
          token,
          urlOptions: {
            addRandomSuffix: true,
            allowedContentTypes: ["application/pdf"],
          },
        };
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Upload failed." }, { status: 400 });
  }
}
