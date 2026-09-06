# Viết work order để xin được lease

Lease treo trên một work order, và work order phải qua Value & Risk Gate
(`FR-DEV-00`). Tài liệu này nói cổng đó chấm cái gì, và vì sao phần lớn lần
thất bại là do hiểu sai luật chứ không phải gõ sai lệnh.

---

## Điều quyết định mọi thứ: cổng TIN lời khai của bạn

Cổng không đọc code và không kiểm chứng gì. Nó chấm **đúng những gì bạn khai**
trong `--checklist` và `--risk`.

Nên khai sai không phải là lách được cổng — đó là đưa một lời khai sai vào hồ sơ
có ghi audit. Khai **thiếu** thì nhẹ hơn nhiều: cổng trả `needs_clarification`
kèm đúng tên mục còn thiếu, bổ sung rồi khai lại là xong.

---

## Ba bậc, và hai bậc không chạy được

Cờ trong `--risk` quyết định bậc:

| Cờ bạn khai | Bậc | Hậu quả |
|---|---|---|
| `touches_pii`, `touches_payment`, `touches_auth`, `touches_production_migration` | **A** | Cổng **từ chối thẳng**, không tạo được work order (`AC-DEV-10`) |
| `touches_cross_service`, `changes_data_model` | **B** | Cổng cho qua, nhưng lease **không được cấp** — chỉ nhận bậc C (`FR-TEN-06`) |
| không cờ nào | **C** | Chạy được |

Bậc B là cái bẫy âm thầm: work order tạo thành công, trông hoàn toàn bình
thường, và **không bao giờ xuất hiện** trong `dsh workorders`. Thấy triệu chứng
đó thì kiểm lại cờ đã khai trước khi nghi ngờ chỗ khác.

Với repo chứa dữ liệu cá nhân — nhân sự, khách hàng, y tế — phần lớn công việc
là `touches_pii` và sẽ bị từ chối. Đó là quyết định phạm vi, không phải rào cản
để tìm cách vòng qua. Việc **chạy được** ở những repo đó là việc không chạm dữ
liệu và không đổi mô hình: sửa giao diện, i18n, refactor không đụng model, bổ
sung test, dọn CI, tối ưu truy vấn sẵn có mà không đổi schema.

Nếu việc bạn định làm thật sự chạm PII: khai đúng cờ, nhận từ chối, và đi đường
khác. Đừng bỏ cờ để lấy bậc C.

---

## Lệnh

```sh
dsh session workorder \
  --title "Sửa bố cục màn hình danh sách trên màn hẹp" \
  --description "Bảng vỡ layout dưới 768px: cột tràn ngang, thanh cuộn ngang che hàng cuối. Chỉ sửa CSS và cấu trúc bảng ở tầng hiển thị. Không đụng truy vấn, không đọc thêm trường nào, không đổi model." \
  --repo "org/ten-repo" \
  --diff-boundary "src/components/" \
  --diff-boundary "src/styles/" \
  --checklist business_outcome,primary_users,happy_path,exception_flow,sample_data_masked,uat_owner,uat_criteria
```

**Không có `--risk`** ở đây là chủ ý: việc chỉ sửa tầng hiển thị nên không cờ nào
áp dụng. Có cờ nào thật sự đúng thì thêm vào, và chấp nhận hệ quả ở bảng trên.

`--diff-boundary` lặp lại được, tuyên bố phạm vi thay đổi. Khai hẹp và đúng thì
dễ rà soát; khai rộng thì mất ý nghĩa.

CLI từ chối key lạ trước khi gửi đi. Gõ sai một mục checklist mà lọt qua sẽ
thành "thiếu mục đó" phía máy chủ, và thông báo sẽ chỉ sai nguyên nhân.

---

## Bảy mục checklist — mỗi mục phải đúng ở đâu

Đủ bảy mục mới qua cổng. Chỉ liệt kê mục nào **thật sự** thoả.

| Mục | Phải có gì thật |
|---|---|
| `business_outcome` | Kết quả nghiệp vụ đo được, không phải mô tả kỹ thuật. "Người dùng xem được danh sách trên điện thoại mà không cuộn ngang" — không phải "sửa CSS". |
| `primary_users` | Vai trò cụ thể, không phải "người dùng". |
| `happy_path` | Luồng thuận đã mô tả ở đâu đó và bạn dẫn ra được. |
| `exception_flow` | Luồng lỗi. Mục hay bị khai bừa nhất — không nghĩ ra được luồng lỗi nào thường nghĩa là chưa hiểu đủ việc. |
| `sample_data_masked` | Dữ liệu mẫu **đã che**. Chưa mask thì mục này chưa thoả, và khai bừa là đưa dữ liệu thật vào chỗ không nên. |
| `uat_owner` | Một người cụ thể nhận UAT. Tên người, không phải tên nhóm. |
| `uat_criteria` | Tiêu chí pass/fail viết trước, để nghiệm thu không thành tranh luận. |

---

## Sau khi tạo

```sh
dsh workorders                 # work order nào chạy được
dsh session run <workorder_id> # nhận lease cho một cái
```

`dsh workorders` chỉ hiện work order thoả cả ba: bậc C đã qua cổng, chưa có lease
ACTIVE, và thuộc về bạn. Danh sách rỗng thì nó nói lý do chứ không im lặng.

Lease sống 4 giờ, trần tuyệt đối 24 giờ. Hết hạn thì chạy lại `dsh session run`
trên **cùng work order cũ** — không cần tạo cái mới.

---

## Khi bị từ chối

**`needs_clarification`** — thông báo liệt kê đúng mục còn thiếu. Bổ sung rồi
tạo lại.

**Bậc A bị từ chối** — không phải lỗi, là thiết kế. Việc chạm dữ liệu cá nhân,
tiền, xác thực hay migration production đi đường khác, không qua chuỗi này.

**Tạo được nhưng `dsh workorders` không thấy** — nhiều khả năng bậc B. Kiểm lại
cờ đã khai.
