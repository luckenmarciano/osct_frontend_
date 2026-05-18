const { getSupabase } = require('../lib/supabase')

/**
 * Upload a buffer to a Supabase storage bucket.
 * Bucket must exist beforehand (create via Supabase dashboard).
 * Returns public URL.
 */
async function uploadToStorage(bucket, path, buffer, contentType) {
  const supabase = getSupabase()
  const { error } = await supabase.storage.from(bucket).upload(path, buffer, {
    contentType,
    upsert: true,
  })
  if (error) throw error

  const { data } = supabase.storage.from(bucket).getPublicUrl(path)
  return data.publicUrl
}

async function deleteFromStorage(bucket, path) {
  const supabase = getSupabase()
  const { error } = await supabase.storage.from(bucket).remove([path])
  if (error) throw error
}

async function getSignedUrl(bucket, path, expiresInSec = 3600) {
  const supabase = getSupabase()
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresInSec)
  if (error) throw error
  return data.signedUrl
}

module.exports = { uploadToStorage, deleteFromStorage, getSignedUrl }
