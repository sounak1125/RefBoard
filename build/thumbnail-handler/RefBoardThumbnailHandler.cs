using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using SharpShell.Attributes;
using SharpShell.SharpThumbnailHandler;

namespace RefBoard
{
    [ComVisible(true)]
    [DisplayName("RefBoard Thumbnail Handler")]
    [Guid("B8E4F1A2-3C5D-4E6F-9A0B-1C2D3E4F5A6B")]
    [COMServerAssociation(AssociationType.ClassOfExtension, ".refboard")]
    public class RefBoardThumbnailHandler : SharpThumbnailHandler
    {
        private const int MaxReadBytes = 512 * 1024;

        private static readonly Regex PreviewRegex = new Regex(
            "\"preview\"\\s*:\\s*\"([A-Za-z0-9+/=]+)\"",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        protected override Bitmap GetThumbnailImage(uint width)
        {
            var target = Math.Max(16, Math.Min(1024, (int)width));
            try
            {
                using (var stream = SelectedItemStream)
                {
                    if (stream == null || !stream.CanRead)
                        return FallbackThumbnail(target);

                    var previewB64 = ExtractPreviewBase64(stream);
                    if (previewB64 == null)
                        return FallbackThumbnail(target);

                    var bytes = Convert.FromBase64String(previewB64);
                    using (var ms = new MemoryStream(bytes))
                    using (var src = new Bitmap(ms))
                    {
                        return ResizePreview(src, target);
                    }
                }
            }
            catch
            {
                return FallbackThumbnail(target);
            }
        }

        private static string ExtractPreviewBase64(Stream stream)
        {
            var headText = ReadChunk(stream, 0);
            if (headText != null)
            {
                var match = PreviewRegex.Match(headText);
                if (match.Success)
                    return match.Groups[1].Value;
            }

            if (stream.CanSeek && stream.Length > MaxReadBytes)
            {
                var tailStart = Math.Max(0, stream.Length - MaxReadBytes);
                var tailText = ReadChunk(stream, tailStart);
                if (tailText != null)
                {
                    var match = PreviewRegex.Match(tailText);
                    if (match.Success)
                        return match.Groups[1].Value;
                }
            }

            return null;
        }

        private static string ReadChunk(Stream stream, long offset)
        {
            // Explorer supplies the initialization stream at position zero. Some shell
            // streams report CanSeek=true but throw E_NOTIMPL even for Seek(0), so do
            // not seek before the head read that contains RefBoard's preview field.
            if (offset != 0)
            {
                if (!stream.CanSeek) return null;
                try
                {
                    stream.Seek(offset, SeekOrigin.Begin);
                }
                catch (NotSupportedException)
                {
                    return null;
                }
                catch (NotImplementedException)
                {
                    return null;
                }
                catch (COMException)
                {
                    return null;
                }
            }

            var bytesToRead = MaxReadBytes;
            if (stream.CanSeek)
            {
                try
                {
                    bytesToRead = (int)Math.Min(MaxReadBytes, Math.Max(0, stream.Length - offset));
                }
                catch (NotSupportedException) { }
                catch (NotImplementedException) { }
                catch (COMException) { }
            }
            if (bytesToRead <= 0) return null;

            var buffer = new byte[bytesToRead];
            var totalRead = 0;
            while (totalRead < buffer.Length)
            {
                var requested = buffer.Length - totalRead;
                int read;
                try
                {
                    read = stream.Read(buffer, totalRead, requested);
                }
                catch (NotImplementedException)
                {
                    if (totalRead == 0) return null;
                    break;
                }
                if (read <= 0) break;
                totalRead += read;
                if (read < requested) break;
            }

            if (totalRead <= 0) return null;
            return Encoding.UTF8.GetString(buffer, 0, totalRead);
        }

        private sealed class ThumbnailLayout
        {
            public int PreviewX;
            public int PreviewY;
            public int PreviewWidth;
            public int PreviewHeight;
            public int Radius;
        }

        private static int Round(float value)
        {
            return (int)Math.Round(value, MidpointRounding.AwayFromZero);
        }

        private static ThumbnailLayout CalculateLayout(int size)
        {
            var padding = Math.Max(1, Round(size * 0.06f));
            var previewWidth = Math.Max(4, size - padding * 2);
            var previewHeight = Math.Max(4, Round(previewWidth * 0.58f));
            var previewX = padding;

            return new ThumbnailLayout
            {
                PreviewX = previewX,
                PreviewY = Round((size - previewHeight) / 2f),
                PreviewWidth = previewWidth,
                PreviewHeight = previewHeight,
                Radius = Math.Max(1, Round(size / 28f)),
            };
        }

        private static Bitmap ResizePreview(Bitmap source, int size)
        {
            // Explorer supplies the RefBoard file-type icon as the lower-right
            // overlay. Keep the provider bitmap content-only so the logo is not
            // drawn twice. Always return the square bitmap Explorer requested;
            // older RefBoard files contain wide previews, so center-crop those.
            var scale = Math.Max((float)size / source.Width, (float)size / source.Height);
            var width = Math.Max(1, Round(source.Width * scale));
            var height = Math.Max(1, Round(source.Height * scale));
            var x = Round((size - width) / 2f);
            var y = Round((size - height) / 2f);
            var canvas = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(canvas))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.SmoothingMode = SmoothingMode.HighQuality;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(source, x, y, width, height);
            }
            return canvas;
        }

        private static void DrawGradientBackground(Graphics g, int size)
        {
            using (var bg = new LinearGradientBrush(
                new Rectangle(0, 0, size, size),
                Color.FromArgb(255, 17, 19, 24),
                Color.FromArgb(255, 24, 27, 34),
                LinearGradientMode.Vertical))
            {
                g.FillRectangle(bg, 0, 0, size, size);
            }
        }

        private static void DrawFallbackPreview(Graphics g, int size, ThumbnailLayout layout)
        {
            using (var shadowPath = RoundedRect(layout.PreviewX + 1, layout.PreviewY + 2, layout.PreviewWidth, layout.PreviewHeight, layout.Radius))
            using (var shadowBrush = new SolidBrush(Color.FromArgb(70, 0, 0, 0)))
                g.FillPath(shadowBrush, shadowPath);

            using (var cardPath = RoundedRect(layout.PreviewX, layout.PreviewY, layout.PreviewWidth, layout.PreviewHeight, layout.Radius))
            using (var cardBrush = new SolidBrush(Color.FromArgb(255, 22, 25, 32)))
                g.FillPath(cardBrush, cardPath);

            var innerPad = Math.Max(1, layout.PreviewWidth / 14);
            var tileGap = Math.Max(1, layout.PreviewWidth / 28);
            var tileWidth = Math.Max(1, (layout.PreviewWidth - innerPad * 2 - tileGap * 2) / 3);
            var innerHeight = Math.Max(2, layout.PreviewHeight - innerPad * 2);
            var tileRadius = Math.Max(1, layout.Radius / 2);
            var x = layout.PreviewX + innerPad;

            using (var blue = new SolidBrush(Color.FromArgb(72, 82, 158, 240)))
            using (var warm = new SolidBrush(Color.FromArgb(64, 217, 163, 106)))
            using (var muted = new SolidBrush(Color.FromArgb(58, 122, 136, 168)))
            using (var tile1 = RoundedRect(x, layout.PreviewY + innerPad, tileWidth, Math.Max(2, Round(innerHeight * 0.55f)), tileRadius))
            using (var tile2 = RoundedRect(x + tileWidth + tileGap, layout.PreviewY + innerPad + Round(innerHeight * 0.18f), tileWidth, Math.Max(2, Round(innerHeight * 0.82f)), tileRadius))
            using (var tile3 = RoundedRect(x + (tileWidth + tileGap) * 2, layout.PreviewY + innerPad, tileWidth, Math.Max(2, Round(innerHeight * 0.65f)), tileRadius))
            {
                g.FillPath(blue, tile1);
                g.FillPath(warm, tile2);
                g.FillPath(muted, tile3);
            }

            using (var borderPath = RoundedRect(layout.PreviewX, layout.PreviewY, layout.PreviewWidth, layout.PreviewHeight, layout.Radius))
            using (var borderPen = new Pen(Color.FromArgb(20, 255, 255, 255), Math.Max(1f, size / 256f)))
                g.DrawPath(borderPen, borderPath);
        }

        private static Bitmap FallbackThumbnail(int size)
        {
            var canvas = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(canvas))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.SmoothingMode = SmoothingMode.HighQuality;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;

                DrawGradientBackground(g, size);
                var layout = CalculateLayout(size);
                DrawFallbackPreview(g, size, layout);
            }
            return canvas;
        }

        private static GraphicsPath RoundedRect(int x, int y, int w, int h, int r)
        {
            var path = new GraphicsPath();
            if (w <= 2 || h <= 2 || r <= 0)
            {
                path.AddRectangle(new Rectangle(x, y, Math.Max(1, w), Math.Max(1, h)));
                return path;
            }
            r = Math.Max(1, Math.Min(r, Math.Min(w, h) / 2));
            var d = r * 2;
            path.AddArc(x, y, d, d, 180, 90);
            path.AddArc(x + w - d, y, d, d, 270, 90);
            path.AddArc(x + w - d, y + h - d, d, d, 0, 90);
            path.AddArc(x, y + h - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }
}
