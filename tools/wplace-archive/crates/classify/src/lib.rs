//! Classify tile responses for the archive.

use wpa_contracts::{ETag, Outcome};

/// Interpret a tile response, requiring a validator to archive a painted tile.
pub fn classify(status: u16, etag_header: Option<&str>, body: Vec<u8>) -> Outcome {
    match status {
        200 => match etag_header.filter(|tag| !tag.is_empty()) {
            Some(tag) => Outcome::Painted {
                bytes: body,
                etag: ETag(tag.to_owned()),
            },
            None => Outcome::Err("200 response arrived without a validator".into()),
        },
        304 => Outcome::Unchanged,
        404 => Outcome::Empty,
        _ => Outcome::Err(format!("unexpected status {status}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_tile_responses() {
        let etag = r#"W/"rev-1""#;
        let body = vec![0, 255];
        let missing_validator = "200 response arrived without a validator";
        let cases = [
            (
                200,
                Some(etag),
                Outcome::Painted {
                    bytes: body.clone(),
                    etag: ETag(etag.into()),
                },
            ),
            (200, None, Outcome::Err(missing_validator.into())),
            (200, Some(""), Outcome::Err(missing_validator.into())),
            (304, None, Outcome::Unchanged),
            (404, None, Outcome::Empty),
            (500, None, Outcome::Err("unexpected status 500".into())),
        ];

        for (status, header, expected) in cases {
            let actual = classify(status, header, body.clone());
            match (actual, expected) {
                (
                    Outcome::Painted { bytes, etag },
                    Outcome::Painted {
                        bytes: expected_bytes,
                        etag: expected_etag,
                    },
                ) => assert_eq!((bytes, etag), (expected_bytes, expected_etag)),
                (Outcome::Unchanged, Outcome::Unchanged) | (Outcome::Empty, Outcome::Empty) => {}
                (Outcome::Err(message), Outcome::Err(expected)) => {
                    assert_eq!(message, expected, "{status} {header:?}");
                }
                (actual, expected) => {
                    panic!("{status} {header:?}: expected {expected:?}, got {actual:?}")
                }
            }
        }
    }
}
