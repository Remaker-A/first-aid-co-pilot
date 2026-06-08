package com.example.cpr_new.hardware.camera

import androidx.camera.core.ImageProxy
import java.nio.ByteBuffer

/** YUV_420_888 → NV21，按 rowStride / pixelStride 正确打包。 */
internal fun ImageProxy.toNv21(): ByteArray {
    val yPlane = planes[0]
    val uPlane = planes[1]
    val vPlane = planes[2]

    val ySize = width * height
    val uvSize = width * height / 2
    val nv21 = ByteArray(ySize + uvSize)

    copyPlane(
        buffer = yPlane.buffer,
        rowStride = yPlane.rowStride,
        pixelStride = yPlane.pixelStride,
        width = width,
        height = height,
        output = nv21,
        offset = 0,
        outputPixelStride = 1,
    )

    // NV21：VU 交错
    var uvOffset = ySize
    val chromaHeight = height / 2
    val chromaWidth = width / 2
    for (row in 0 until chromaHeight) {
        var col = 0
        while (col < chromaWidth) {
            val vIndex = row * vPlane.rowStride + col * vPlane.pixelStride
            val uIndex = row * uPlane.rowStride + col * uPlane.pixelStride
            nv21[uvOffset++] = vPlane.buffer.get(vIndex)
            nv21[uvOffset++] = uPlane.buffer.get(uIndex)
            col++
        }
    }
    return nv21
}

private fun copyPlane(
    buffer: ByteBuffer,
    rowStride: Int,
    pixelStride: Int,
    width: Int,
    height: Int,
    output: ByteArray,
    offset: Int,
    outputPixelStride: Int,
) {
    var outputPos = offset
    for (row in 0 until height) {
        var inputPos = row * rowStride
        for (col in 0 until width) {
            output[outputPos] = buffer.get(inputPos)
            inputPos += pixelStride
            outputPos += outputPixelStride
        }
    }
}
