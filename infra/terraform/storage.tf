resource "google_storage_bucket" "internal_documents" {
  name                        = var.internal_bucket_name
  project                     = var.project_id
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = false

  depends_on = [google_project_service.apis]
}
