const fs = require('fs/promises');

class ImageHandler {
  static SUPPORTED_FORMATS = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

  static SUPPORTED_DOCUMENT_FORMATS = [
    'text/plain', 'text/markdown', 'text/csv',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel'
  ];

  static MAX_SIZE_BYTES = 5 * 1024 * 1024;

  static MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024;

  static MAX_IMAGES_PER_MESSAGE = 5;

  static MAX_DOCUMENTS_PER_MESSAGE = 5;

  static async processImage(input = {}) {
    if (!input || typeof input !== 'object') {
      throw new Error('Invalid image input');
    }

    if (input.type === 'file') {
      const filePath = String(input.path || '').trim();
      if (!filePath) {
        throw new Error('Image file path is required');
      }
      const buffer = await fs.readFile(filePath);
      const mimeType = String(input.mimeType || '').trim().toLowerCase();
      this.validateImage(buffer, mimeType);
      return {
        base64: buffer.toString('base64'),
        mimeType,
        sizeBytes: buffer.length,
        name: input.name || undefined
      };
    }

    if (input.type === 'base64') {
      const mimeType = String(input.mimeType || '').trim().toLowerCase();
      const base64 = String(input.data || '').trim();
      if (!base64) {
        throw new Error('Base64 image data is required');
      }
      const buffer = Buffer.from(base64, 'base64');
      this.validateImage(buffer, mimeType);
      return {
        base64: buffer.toString('base64'),
        mimeType,
        sizeBytes: buffer.length,
        name: input.name || undefined
      };
    }

    if (input.type === 'url') {
      const url = String(input.url || '').trim();
      if (!url) {
        throw new Error('Image URL is required');
      }

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch image URL: ${response.status} ${response.statusText}`);
      }

      const mimeType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      this.validateImage(buffer, mimeType);

      return {
        base64: buffer.toString('base64'),
        mimeType,
        sizeBytes: buffer.length
      };
    }

    throw new Error(`Unsupported image input type: ${input.type}`);
  }

  static formatForProvider(provider, imageData = {}) {
    if (provider === 'openai') {
      return {
        type: 'image_url',
        image_url: {
          url: `data:${imageData.mimeType};base64,${imageData.base64}`
        }
      };
    }

    if (provider === 'anthropic') {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: imageData.mimeType,
          data: imageData.base64
        }
      };
    }

    if (provider === 'gemini') {
      return {
        inlineData: {
          mimeType: imageData.mimeType,
          data: imageData.base64
        }
      };
    }

    throw new Error(`Provider ${provider} does not support images`);
  }

  static validateImage(buffer, mimeType) {
    if (!Buffer.isBuffer(buffer)) {
      throw new Error('Invalid image data: expected Buffer');
    }

    if (!this.SUPPORTED_FORMATS.includes(mimeType)) {
      throw new Error(`Unsupported image format: ${mimeType}. Supported: ${this.SUPPORTED_FORMATS.join(', ')}`);
    }

    if (buffer.length > this.MAX_SIZE_BYTES) {
      throw new Error(`Image too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB. Max: 5MB`);
    }
  }

  static formatDocumentForProvider(provider, docData = {}) {
    const { mimeType, base64, name, textContent } = docData;
    const isTextBased = mimeType === 'text/plain' || mimeType === 'text/markdown' || mimeType === 'text/csv';
    const isExcel = mimeType.includes('spreadsheet') || mimeType.includes('excel');

    if (isTextBased) {
      const content = textContent || Buffer.from(base64, 'base64').toString('utf-8');
      return { type: 'text', text: `--- ${name || 'document'} ---\n${content}\n--- end ---` };
    }

    if (isExcel) {
      try {
        const XLSX = require('xlsx');
        const buffer = Buffer.from(base64, 'base64');
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const sheets = workbook.SheetNames.map((sheetName) => {
          const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
          return `[Sheet: ${sheetName}]\n${csv}`;
        });
        return { type: 'text', text: `--- ${name || 'spreadsheet'} ---\n${sheets.join('\n\n')}\n--- end ---` };
      } catch (err) {
        return { type: 'text', text: `--- ${name || 'spreadsheet'} ---\n[Error reading spreadsheet: ${err.message}]\n--- end ---` };
      }
    }

    if (mimeType === 'application/pdf') {
      if (provider === 'anthropic') {
        return {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: base64
          }
        };
      }
      if (provider === 'gemini') {
        return {
          inlineData: {
            mimeType: 'application/pdf',
            data: base64
          }
        };
      }
      // OpenAI doesn't support PDF natively - include as a note
      return { type: 'text', text: `--- ${name || 'document.pdf'} ---\n[PDF file attached - content not extractable in this provider]\n--- end ---` };
    }

    return { type: 'text', text: `[Unsupported document type: ${mimeType}]` };
  }

  static normalizeMessageDocuments(documents = []) {
    if (!Array.isArray(documents) || documents.length === 0) {
      return [];
    }

    if (documents.length > this.MAX_DOCUMENTS_PER_MESSAGE) {
      throw new Error(`Too many documents: ${documents.length}. Max: ${this.MAX_DOCUMENTS_PER_MESSAGE}`);
    }

    return documents.map((item) => {
      const mimeType = String(item?.mimeType || '').trim().toLowerCase();
      if (!this.SUPPORTED_DOCUMENT_FORMATS.includes(mimeType)) {
        throw new Error(`Unsupported document format: ${mimeType}`);
      }

      const base64 = String(item?.base64 || '').trim();
      if (!base64) {
        throw new Error('Document base64 data is required');
      }

      const buffer = Buffer.from(base64, 'base64');
      if (buffer.length > this.MAX_DOCUMENT_SIZE_BYTES) {
        throw new Error(`Document too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB. Max: 10MB`);
      }

      return {
        base64,
        mimeType,
        name: item?.name ? String(item.name) : undefined,
        textContent: item?.textContent ? String(item.textContent) : undefined,
        sizeBytes: buffer.length
      };
    });
  }

  static normalizeMessageImages(images = []) {
    if (!Array.isArray(images) || images.length === 0) {
      return [];
    }

    if (images.length > this.MAX_IMAGES_PER_MESSAGE) {
      throw new Error(`Too many images: ${images.length}. Max: ${this.MAX_IMAGES_PER_MESSAGE}`);
    }

    return images.map((item) => {
      const processed = {
        base64: String(item?.base64 || '').trim(),
        mimeType: String(item?.mimeType || '').trim().toLowerCase(),
        name: item?.name ? String(item.name) : undefined
      };

      if (!processed.base64) {
        throw new Error('Image base64 data is required');
      }

      const buffer = Buffer.from(processed.base64, 'base64');
      this.validateImage(buffer, processed.mimeType);

      return {
        ...processed,
        sizeBytes: buffer.length
      };
    });
  }
}

module.exports = ImageHandler;