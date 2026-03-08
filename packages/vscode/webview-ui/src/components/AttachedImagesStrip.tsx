import React, { useRef } from "react"
import { useChatStore } from "../stores/chat.js"

const readFileAsBase64 = (file: File): Promise<{ data: string; mimeType: string }> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const base64 = result.includes(",") ? result.split(",")[1]! : result
      resolve({ data: base64, mimeType: file.type || "image/png" })
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function ImageIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  )
}

/** Thumbnails of attached images + pick button; hover on thumbnail shows remove (X) in top-right. */
export function AttachedImagesStripWithPicker({ registerImagePickerTrigger }: { registerImagePickerTrigger?: (trigger: () => void) => void }) {
  const { attachedImages, addAttachedImage, removeAttachedImage } = useChatStore()
  const fileInputRef = useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    registerImagePickerTrigger?.(() => fileInputRef.current?.click())
  }, [registerImagePickerTrigger])

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files?.length) return
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!
      if (!file.type.startsWith("image/")) continue
      try {
        const { data, mimeType } = await readFileAsBase64(file)
        addAttachedImage(data, mimeType)
      } catch {
        // ignore
      }
    }
    e.target.value = ""
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="nexus-attached-images-input-hidden"
        onChange={handleFileSelect}
        aria-label="Attach image"
      />
      {attachedImages.length > 0 && (
      <div className="nexus-attached-images-row">
          <div className="nexus-attached-images-strip">
            {attachedImages.map((img) => (
              <div
                key={img.id}
                className="nexus-attached-image-wrap"
                title="Click × to remove"
              >
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt="Attached"
                  className="nexus-attached-image-thumb"
                />
                <button
                  type="button"
                  className="nexus-attached-image-remove"
                  onClick={() => removeAttachedImage(img.id)}
                  aria-label="Remove image"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
      </div>
      )}
    </>
  )
}
