-- Complete the quality-gated Website Builder migration (#836).
-- 0156 shipped before FWS exposed durable diagnostics and real rendered captures. This
-- upgrades only the still-exact stock v2 subscriber copy, archives it, and adds the
-- resumable same-session reviewer-feedback pipeline. The durable pipeline workflow owns
-- idempotent step replay; site-refine intentionally never calls create_site or deploy.
UPDATE agents
SET config = json_set(
      CASE WHEN json_valid(config) THEN config ELSE '{}' END,
      '$.pipelines.site-builder',
      json('{
  "name": "site-builder",
  "params": {
    "place_id": {
      "type": "string",
      "description": "Google Places id of the lead — the one required input; everything else is looked up."
    },
    "mcp_url": {
      "type": "string",
      "description": "Website-builder MCP endpoint. Per-instance config: no server is hardcoded in the platform."
    },
    "template_slug": {
      "type": "string",
      "description": "Optional designer-template preference. The builder lists the live catalogue and chooses a suitable returned slug."
    },
    "photo_limit": {
      "type": "number",
      "description": "How many venue photos to pull into the gallery (default 4)."
    }
  },
  "steps": [
    {
      "tool": "http_request",
      "bind": "details",
      "inputs": {
        "method": "GET",
        "url": "https://places.googleapis.com/v1/places/{{place_id}}",
        "inputs": {
          "place_id": {
            "$param": "place_id"
          }
        },
        "headers": {
          "X-Goog-FieldMask": "id,displayName,formattedAddress,shortFormattedAddress,nationalPhoneNumber,websiteUri,googleMapsUri,rating,userRatingCount,editorialSummary,regularOpeningHours,primaryTypeDisplayName,photos,addressComponents"
        },
        "auth": {
          "mode": "api-key",
          "key": {
            "in": "header",
            "name": "X-Goog-Api-Key"
          }
        }
      }
    },
    {
      "tool": "slice",
      "bind": "shots",
      "inputs": {
        "items": {
          "$ref": "details.data.photos"
        },
        "limit": {
          "$param": "photo_limit"
        }
      }
    },
    {
      "tool": "http_request",
      "bind": "photoPages",
      "forEach": {
        "$ref": "shots.items"
      },
      "inputs": {
        "method": "GET",
        "url": "https://places.googleapis.com/v1/{{photo}}/media",
        "inputs": {
          "photo": {
            "$param": "item.name"
          }
        },
        "query": {
          "maxWidthPx": 1200,
          "skipHttpRedirect": "true"
        },
        "auth": {
          "mode": "api-key",
          "key": {
            "in": "query",
            "name": "key"
          }
        },
        "responseMap": "photoUri"
      }
    },
    {
      "tool": "flatten",
      "bind": "photos",
      "inputs": {
        "items": {
          "$ref": "photoPages"
        },
        "path": "data"
      }
    },
    {
      "tool": "map",
      "bind": "base",
      "inputs": {
        "items": [
          {
            "d": {
              "$ref": "details.data"
            },
            "place_id": {
              "$param": "place_id"
            }
          }
        ],
        "extract": {
          "name": "d.displayName.text",
          "address": "d.formattedAddress",
          "short_address": "d.shortFormattedAddress",
          "phone": "d.nationalPhoneNumber",
          "maps_url": "d.googleMapsUri",
          "rating": "d.rating",
          "reviews_count": "d.userRatingCount",
          "blurb": "d.editorialSummary.text",
          "hours": "d.regularOpeningHours.weekdayDescriptions",
          "kind": "d.primaryTypeDisplayName.text",
          "suburb": "d.addressComponents[types~=locality].longText",
          "state": "d.addressComponents[types~=administrative_area_level_1].longText"
        },
        "keep": [
          "place_id"
        ],
        "derive": {
          "search_query": {
            "$format": "{{name}} {{suburb}} instagram facebook"
          },
          "ticket_title": {
            "$format": "Deploy the site for {{name}}"
          }
        }
      }
    },
    {
      "tool": "web_search",
      "bind": "hits",
      "inputs": {
        "query": {
          "$ref": "base.items.0.search_query"
        },
        "num": 8
      }
    },
    {
      "tool": "extract_contacts",
      "bind": "contacts",
      "inputs": {
        "items": {
          "$ref": "hits"
        }
      }
    },
    {
      "tool": "map",
      "bind": "biz",
      "inputs": {
        "items": [
          {
            "b": {
              "$ref": "base.items.0"
            },
            "c": {
              "$ref": "contacts"
            },
            "photo_urls": {
              "$ref": "photos.items"
            }
          }
        ],
        "extract": {
          "place_id": "b.place_id",
          "name": "b.name",
          "address": "b.address",
          "short_address": "b.short_address",
          "phone": "b.phone",
          "maps_url": "b.maps_url",
          "rating": "b.rating",
          "reviews_count": "b.reviews_count",
          "blurb": "b.blurb",
          "hours": "b.hours",
          "kind": "b.kind",
          "suburb": "b.suburb",
          "state": "b.state",
          "ticket_title": "b.ticket_title",
          "instagram": "c.instagram",
          "facebook": "c.facebook",
          "email": "c.email"
        },
        "keep": [
          "photo_urls"
        ]
      }
    },
    {
      "tool": "ai_generate",
      "bind": "drafted",
      "inputs": {
        "items": {
          "$ref": "biz.items"
        },
        "system": "You write short, plain, honest copy for a small local business''s first website. You are given ONLY facts scraped from Google Maps and public social profiles. Never invent a fact: no awards, no founding year, no staff names, no claims about quality, price or history you were not given. If you have little to work with, write less. Australian/British spelling. No emoji, no exclamation marks, no ''nestled in the heart of''. Reply with ONLY a JSON object — no prose, no code fence.",
        "prompt": "Business facts:\n- Name: {{name}}\n- Type: {{kind}}\n- Address: {{address}}\n- Suburb: {{suburb}}, {{state}}\n- Phone: {{phone}}\n- Google rating: {{rating}} from {{reviews_count}} reviews\n- Google''s own summary: {{blurb}}\n- Opening hours: {{hours}}\n- Photo URLs (comma-separated, may be empty): {{photo_urls}}\n\nReturn JSON with exactly these keys:\n{\n  \"tagline\": \"6-10 words for the hero. What they are and where.\",\n  \"meta_description\": \"One sentence under 155 characters for search results.\",\n  \"about_html\": \"2-3 short sentences as HTML paragraphs. Only what the facts above support.\",\n  \"services_html\": \"A <ul> of 3-5 short items a customer would come here for, inferred from the business TYPE alone.\",\n  \"gallery_html\": \"For each photo URL above, one <img src=\\\"THE URL VERBATIM\\\" alt=\\\"...\\\" loading=\\\"lazy\\\"> wrapped in a <div class=\\\"grid\\\">. Copy each URL character-for-character; never shorten or invent one. Empty string if there are no photo URLs.\",\n  \"hours_line\": \"The opening hours as one readable line, or \\\"\\\" if unknown.\",\n  \"category\": \"one of: restaurant, cafe, salon, trades, retail, fitness, professional, health, education, creative, other\",\n  \"slug\": \"The business name as a URL slug: lowercase letters, numbers and hyphens ONLY, no leading/trailing hyphen, 3-40 characters. Add the suburb if the name alone is generic.\"\n}",
        "as": "copy_json",
        "maxTokens": 900
      }
    },
    {
      "tool": "parse_json",
      "bind": "copy",
      "inputs": {
        "items": {
          "$ref": "drafted.items"
        },
        "field": "copy_json",
        "as": "copy"
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "templates",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "list_templates",
        "args": {}
      }
    },
    {
      "tool": "stringify_json",
      "bind": "templateCatalog",
      "inputs": {
        "value": {
          "$ref": "templates.data"
        },
        "pretty": true
      }
    },
    {
      "tool": "map",
      "bind": "templateContext",
      "inputs": {
        "items": [
          {
            "b": {
              "$ref": "biz.items.0"
            },
            "templates": {
              "$ref": "templateCatalog.text"
            },
            "preferred_template_slug": {
              "$param": "template_slug"
            }
          }
        ],
        "extract": {
          "name": "b.name",
          "kind": "b.kind",
          "suburb": "b.suburb"
        },
        "keep": [
          "templates",
          "preferred_template_slug"
        ]
      }
    },
    {
      "tool": "ai_generate",
      "bind": "templateDraft",
      "inputs": {
        "items": {
          "$ref": "templateContext.items"
        },
        "system": "Choose an appropriate existing designer template for a local business. Use only template_slug values literally present in the supplied catalogue. A preferred slug is a preference, not a mandate. Record two genuine alternate candidate slugs when the catalogue has them. Reply ONLY JSON.",
        "prompt": "Business: {{name}} ({{kind}}), {{suburb}}.\nTemplate catalogue:\n{{templates}}\nPreferred template: {{preferred_template_slug}}\nReturn {\"template_slug\":\"exact catalogue slug\",\"reason\":\"short factual rationale\",\"alternates\":[\"other exact catalogue slug\"]}. Alternates must be different real catalogue slugs; use [] only when no other candidate exists.",
        "as": "template_json",
        "maxTokens": 300
      }
    },
    {
      "tool": "parse_json",
      "bind": "templateChoice",
      "inputs": {
        "items": {
          "$ref": "templateDraft.items"
        },
        "field": "template_json",
        "as": "template"
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "site",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "create_site",
        "args": {
          "template_slug": {
            "$ref": "templateChoice.items.0.template.template_slug"
          }
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "sections",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "list_sections",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          }
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "sectionReads",
      "forEach": {
        "$ref": "sections.data.sections"
      },
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "read_section",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          },
          "section_id": {
            "$param": "item.id"
          }
        }
      }
    },
    {
      "tool": "stringify_json",
      "bind": "sectionSource",
      "inputs": {
        "value": {
          "$ref": "sectionReads"
        },
        "pretty": true
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "sectionContext",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "get_quality_report",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          }
        }
      }
    },
    {
      "tool": "stringify_json",
      "bind": "sectionDiagnostics",
      "inputs": {
        "value": {
          "$ref": "sectionContext.data"
        },
        "pretty": true
      }
    },
    {
      "tool": "ai_generate",
      "bind": "sectionPlan",
      "inputs": {
        "items": [
          {
            "sections": {
              "$ref": "sectionSource.text"
            },
            "diagnostics": {
              "$ref": "sectionDiagnostics.text"
            }
          }
        ],
        "system": "You improve an existing designer template. Use only section IDs in the supplied sections. Preserve every existing section wrapper and className: return inner HTML only, never a section wrapper or className. Only return deliberate updates. Reply ONLY JSON.",
        "prompt": "Existing sections (including wrapper className):\n{{sections}}\nCurrent diagnostics:\n{{diagnostics}}\nReturn {\"sections\":[{\"id\":\"existing id\",\"content\":\"replacement inner HTML\",\"label\":\"optional\"}]}. Each id must be an existing id. Do not return className or wrapper HTML. Use no invented business claims.",
        "as": "plan_json",
        "maxTokens": 1500
      }
    },
    {
      "tool": "parse_json",
      "bind": "plannedSections",
      "inputs": {
        "items": {
          "$ref": "sectionPlan.items"
        },
        "field": "plan_json",
        "as": "plan"
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "meta",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "set_meta",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          },
          "title": {
            "$ref": "copy.items.0.name"
          },
          "description": {
            "$ref": "copy.items.0.copy.meta_description"
          },
          "noindex": true
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "contact",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "set_contact",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          },
          "phone": {
            "$ref": "copy.items.0.phone"
          },
          "email": {
            "$ref": "copy.items.0.email"
          },
          "address": {
            "$ref": "copy.items.0.address"
          },
          "hours": {
            "$ref": "copy.items.0.copy.hours_line"
          }
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "social",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "set_social",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          },
          "instagram": {
            "$ref": "copy.items.0.instagram"
          },
          "facebook": {
            "$ref": "copy.items.0.facebook"
          }
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "aboutSection",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "add_section",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          },
          "type": "about",
          "label": "About",
          "content": {
            "$ref": "copy.items.0.copy.about_html"
          }
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "servicesSection",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "add_section",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          },
          "type": "features",
          "label": "What we do",
          "content": {
            "$ref": "copy.items.0.copy.services_html"
          }
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "gallerySection",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "add_section",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          },
          "type": "gallery",
          "label": "Gallery",
          "content": {
            "$ref": "copy.items.0.copy.gallery_html"
          }
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "updatedTemplateSections",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "bulk_update_sections",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          },
          "sections": {
            "$ref": "plannedSections.items.0.plan.sections"
          }
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "quality1",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "get_quality_report",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          }
        }
      }
    },
    {
      "tool": "map",
      "bind": "qa1",
      "inputs": {
        "items": [
          {
            "ready": {
              "$ref": "quality1.data.ready_for_human_review"
            }
          }
        ],
        "keep": [
          "ready"
        ],
        "derive": {
          "needs_refinement": {
            "$cond": {
              "field": "ready",
              "op": "falsy"
            },
            "then": true,
            "else": false
          },
          "passed": {
            "$cond": {
              "field": "ready",
              "op": "truthy"
            },
            "then": true,
            "else": false
          }
        }
      }
    },
    {
      "tool": "stringify_json",
      "bind": "quality1Text",
      "inputs": {
        "value": {
          "$ref": "quality1.data"
        },
        "pretty": true
      }
    },
    {
      "tool": "ai_generate",
      "bind": "refinementDraft",
      "when": {
        "$ref": "qa1.items.0.needs_refinement"
      },
      "inputs": {
        "items": [
          {
            "sections": {
              "$ref": "sectionSource.text"
            },
            "quality": {
              "$ref": "quality1Text.text"
            }
          }
        ],
        "system": "Repair only the reported static quality failures. Use only existing section IDs. Preserve every section wrapper and className by returning inner HTML only; never return className or wrapper HTML. Reply ONLY JSON.",
        "prompt": "Quality report:\n{{quality}}\nCurrent sections:\n{{sections}}\nReturn {\"sections\":[{\"id\":\"existing id\",\"content\":\"replacement inner HTML\",\"label\":\"optional\"}]}. Make only changes that address the report.",
        "as": "refinement_json",
        "maxTokens": 1400
      }
    },
    {
      "tool": "parse_json",
      "bind": "refinement",
      "when": {
        "$ref": "qa1.items.0.needs_refinement"
      },
      "inputs": {
        "items": {
          "$ref": "refinementDraft.items"
        },
        "field": "refinement_json",
        "as": "plan"
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "refinedSections",
      "when": {
        "$ref": "qa1.items.0.needs_refinement"
      },
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "bulk_update_sections",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          },
          "sections": {
            "$ref": "refinement.items.0.plan.sections"
          }
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "quality2",
      "when": {
        "$ref": "qa1.items.0.needs_refinement"
      },
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "get_quality_report",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          }
        }
      }
    },
    {
      "tool": "map",
      "bind": "qa2",
      "when": {
        "$ref": "qa1.items.0.needs_refinement"
      },
      "inputs": {
        "items": [
          {
            "ready": {
              "$ref": "quality2.data.ready_for_human_review"
            }
          }
        ],
        "keep": [
          "ready"
        ],
        "derive": {
          "needs_refinement": {
            "$cond": {
              "field": "ready",
              "op": "falsy"
            },
            "then": true,
            "else": false
          },
          "passed": {
            "$cond": {
              "field": "ready",
              "op": "truthy"
            },
            "then": true,
            "else": false
          }
        }
      }
    },
    {
      "tool": "stringify_json",
      "bind": "quality2Text",
      "when": {
        "$ref": "qa2.items.0.needs_refinement"
      },
      "inputs": {
        "value": {
          "$ref": "quality2.data"
        },
        "pretty": true
      }
    },
    {
      "tool": "ai_generate",
      "bind": "refinementDraft2",
      "when": {
        "$ref": "qa2.items.0.needs_refinement"
      },
      "inputs": {
        "items": [
          {
            "sections": {
              "$ref": "sectionSource.text"
            },
            "quality": {
              "$ref": "quality2Text.text"
            }
          }
        ],
        "system": "Repair only the reported static quality failures. This is the final automatic revision. Use only existing section IDs and preserve every wrapper/className by returning inner HTML only. Reply ONLY JSON.",
        "prompt": "Quality report:\n{{quality}}\nCurrent sections:\n{{sections}}\nReturn {\"sections\":[{\"id\":\"existing id\",\"content\":\"replacement inner HTML\",\"label\":\"optional\"}]}. Make only changes that address the report.",
        "as": "refinement_json",
        "maxTokens": 1400
      }
    },
    {
      "tool": "parse_json",
      "bind": "refinement2",
      "when": {
        "$ref": "qa2.items.0.needs_refinement"
      },
      "inputs": {
        "items": {
          "$ref": "refinementDraft2.items"
        },
        "field": "refinement_json",
        "as": "plan"
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "refinedSections2",
      "when": {
        "$ref": "qa2.items.0.needs_refinement"
      },
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "bulk_update_sections",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          },
          "sections": {
            "$ref": "refinement2.items.0.plan.sections"
          }
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "quality3",
      "when": {
        "$ref": "qa2.items.0.needs_refinement"
      },
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "get_quality_report",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          }
        }
      }
    },
    {
      "tool": "map",
      "bind": "finalGate",
      "inputs": {
        "items": [
          {
            "initial_passed": {
              "$ref": "qa1.items.0.passed"
            },
            "revision1_passed": {
              "$ref": "qa2.items.0.passed"
            },
            "revision2_passed": {
              "$ref": "quality3.data.ready_for_human_review"
            }
          }
        ],
        "keep": [
          "initial_passed",
          "revision1_passed",
          "revision2_passed"
        ],
        "derive": {
          "passed": {
            "$cond": {
              "field": "initial_passed",
              "op": "truthy"
            },
            "then": true,
            "else": {
              "$cond": {
                "field": "revision1_passed",
                "op": "truthy"
              },
              "then": true,
              "else": {
                "$cond": {
                  "field": "revision2_passed",
                  "op": "truthy"
                },
                "then": true,
                "else": false
              }
            }
          },
          "needs_attention": {
            "$cond": {
              "field": "initial_passed",
              "op": "truthy"
            },
            "then": false,
            "else": {
              "$cond": {
                "field": "revision1_passed",
                "op": "truthy"
              },
              "then": false,
              "else": {
                "$cond": {
                  "field": "revision2_passed",
                  "op": "truthy"
                },
                "then": false,
                "else": true
              }
            }
          },
          "iteration_count": {
            "$cond": {
              "field": "initial_passed",
              "op": "truthy"
            },
            "then": 0,
            "else": {
              "$cond": {
                "field": "revision1_passed",
                "op": "truthy"
              },
              "then": 1,
              "else": 2
            }
          },
          "state": {
            "$cond": {
              "field": "initial_passed",
              "op": "truthy"
            },
            "then": "qa_passed",
            "else": {
              "$cond": {
                "field": "revision1_passed",
                "op": "truthy"
              },
              "then": "qa_passed",
              "else": {
                "$cond": {
                  "field": "revision2_passed",
                  "op": "truthy"
                },
                "then": "qa_passed",
                "else": "needs_attention"
              }
            }
          }
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "desktopCapture",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "capture_preview",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          },
          "viewport": "desktop"
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "mobileCapture",
      "inputs": {
        "url": {
          "$param": "mcp_url"
        },
        "tool": "capture_preview",
        "args": {
          "session_id": {
            "$ref": "site.data.session_id"
          },
          "viewport": "mobile"
        }
      }
    },
    {
      "tool": "create_ticket",
      "bind": "gate",
      "when": {
        "$ref": "finalGate.items.0.passed"
      },
      "inputs": {
        "title": {
          "$ref": "copy.items.0.ticket_title"
        },
        "reasoning": "QA passed after bounded draft revisions with FWS static diagnostics and desktop/mobile rendered captures. Nothing is live: the draft remains noindex and no domain is claimed. Approving deploys this exact session only.",
        "action": "run_pipeline",
        "config": {
          "pipeline": "site-deploy"
        },
        "params": {
          "place_id": {
            "$param": "place_id"
          },
          "mcp_url": {
            "$param": "mcp_url"
          },
          "session_id": {
            "$ref": "site.data.session_id"
          },
          "name": {
            "$ref": "copy.items.0.name"
          },
          "slug": {
            "$ref": "copy.items.0.copy.slug"
          },
          "category": {
            "$ref": "copy.items.0.copy.category"
          },
          "description": {
            "$ref": "copy.items.0.copy.meta_description"
          },
          "suburb": {
            "$ref": "copy.items.0.suburb"
          },
          "address": {
            "$ref": "copy.items.0.address"
          },
          "phone": {
            "$ref": "copy.items.0.phone"
          },
          "email": {
            "$ref": "copy.items.0.email"
          }
        }
      }
    },
    {
      "tool": "map",
      "bind": "evidence",
      "inputs": {
        "items": [
          {
            "business": {
              "$ref": "biz.items.0"
            },
            "copy": {
              "$ref": "copy.items.0.copy"
            },
            "template": {
              "$ref": "templateChoice.items.0.template"
            },
            "session_id": {
              "$ref": "site.data.session_id"
            },
            "quality_initial": {
              "$ref": "quality1.data"
            },
            "quality_revision_1": {
              "$ref": "quality2.data"
            },
            "quality_revision_2": {
              "$ref": "quality3.data"
            },
            "desktop_capture": {
              "$ref": "desktopCapture.data"
            },
            "mobile_capture": {
              "$ref": "mobileCapture.data"
            },
            "gate": {
              "$ref": "finalGate.items.0"
            }
          }
        ],
        "extract": {
          "place_id": "business.place_id",
          "name": "business.name",
          "address": "business.address",
          "phone": "business.phone",
          "maps_url": "business.maps_url",
          "suburb": "business.suburb",
          "state": "business.state",
          "instagram": "business.instagram",
          "facebook": "business.facebook",
          "email": "business.email",
          "photo_urls": "business.photo_urls",
          "site_session_id": "session_id",
          "template_slug": "template.template_slug",
          "template_rationale": "template.reason",
          "template_alternates": "template.alternates",
          "quality_initial": "quality_initial",
          "quality_revision_1": "quality_revision_1",
          "quality_revision_2": "quality_revision_2",
          "desktop_capture": "desktop_capture",
          "mobile_capture": "mobile_capture",
          "quality_iteration_count": "gate.iteration_count",
          "site_state": "gate.state"
        }
      }
    },
    {
      "tool": "map",
      "bind": "record",
      "when": {
        "$ref": "finalGate.items.0.passed"
      },
      "inputs": {
        "items": {
          "$ref": "evidence.items"
        },
        "derive": {
          "site_status": "awaiting_approval"
        }
      }
    },
    {
      "tool": "dedupe_upsert",
      "bind": "stored",
      "when": {
        "$ref": "finalGate.items.0.passed"
      },
      "inputs": {
        "items": {
          "$ref": "record.items"
        },
        "collection": "sites",
        "key": "place_id",
        "mode": "update",
        "emit": "site.drafted"
      }
    },
    {
      "tool": "create_ticket",
      "bind": "needsAttention",
      "when": {
        "$ref": "finalGate.items.0.needs_attention"
      },
      "inputs": {
        "title": "Website draft needs attention",
        "status": "needs_human",
        "reasoning": "The noindex draft still fails FWS quality diagnostics after the maximum two automatic revisions. Desktop and mobile captures were collected. Nothing was deployed. Resume the existing FWS session with the site-refine pipeline and reviewer feedback; do not create a replacement draft.",
        "description": "The sites record holds the session id, template choice, quality reports, iteration count, and capture metadata."
      }
    },
    {
      "tool": "map",
      "bind": "needsAttentionRecord",
      "when": {
        "$ref": "finalGate.items.0.needs_attention"
      },
      "inputs": {
        "items": {
          "$ref": "evidence.items"
        },
        "derive": {
          "site_status": "needs_attention"
        }
      }
    },
    {
      "tool": "dedupe_upsert",
      "bind": "storedNeedsAttention",
      "when": {
        "$ref": "finalGate.items.0.needs_attention"
      },
      "inputs": {
        "items": {
          "$ref": "needsAttentionRecord.items"
        },
        "collection": "sites",
        "key": "place_id",
        "mode": "update",
        "emit": "site.needs_attention"
      }
    }
  ],
  "sink": {
    "collection": "sites",
    "keyField": "place_id"
  }
}'),
      '$.pipelines.site-refine',
      json('{
  "name": "site-refine",
  "params": {
    "session_id": { "type": "string", "description": "Existing noindex FWS draft session to refine; never creates a new draft." },
    "mcp_url": { "type": "string", "description": "The same Website Builder MCP endpoint that owns the draft." },
    "feedback": { "type": "string", "description": "Reviewer feedback to apply to this existing draft." },
    "place_id": { "type": "string", "description": "Lead record to update after review." },
    "name": { "type": "string", "description": "Business display name for a later human-approved deploy." },
    "slug": { "type": "string", "description": "Reserved draft slug for a later human-approved deploy." },
    "category": { "type": "string", "description": "Business category for a later human-approved deploy." },
    "description": { "type": "string", "description": "SEO description for a later human-approved deploy." },
    "suburb": { "type": "string", "description": "Lead suburb retained for outreach." },
    "address": { "type": "string", "description": "Lead address retained for outreach." },
    "phone": { "type": "string", "description": "Lead phone retained for outreach." },
    "email": { "type": "string", "description": "Lead email retained for outreach." },
    "prior_iteration_count": { "type": "number", "description": "Automatic revisions already recorded on the draft.", "default": 0 }
  },
  "steps": [
    {
      "tool": "mcp_call_tool",
      "bind": "sections",
      "inputs": { "url": { "$param": "mcp_url" }, "tool": "list_sections", "args": { "session_id": { "$param": "session_id" } } }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "sectionReads",
      "forEach": { "$ref": "sections.data.sections" },
      "inputs": { "url": { "$param": "mcp_url" }, "tool": "read_section", "args": { "session_id": { "$param": "session_id" }, "section_id": { "$param": "item.id" } } }
    },
    {
      "tool": "stringify_json",
      "bind": "sectionSource",
      "inputs": { "value": { "$ref": "sectionReads" }, "pretty": true }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "qualityBefore",
      "inputs": { "url": { "$param": "mcp_url" }, "tool": "get_quality_report", "args": { "session_id": { "$param": "session_id" } } }
    },
    {
      "tool": "stringify_json",
      "bind": "qualityBeforeText",
      "inputs": { "value": { "$ref": "qualityBefore.data" }, "pretty": true }
    },
    {
      "tool": "ai_generate",
      "bind": "refinementDraft",
      "inputs": {
        "items": [{ "sections": { "$ref": "sectionSource.text" }, "quality": { "$ref": "qualityBeforeText.text" }, "feedback": { "$param": "feedback" } }],
        "system": "Apply reviewer feedback and repair reported quality failures on one existing designer-template draft. Use only supplied section IDs. Preserve every wrapper and className by returning inner HTML only; never return className or section wrapper HTML. Reply ONLY JSON.",
        "prompt": "Reviewer feedback:\n{{feedback}}\nQuality report:\n{{quality}}\nExisting sections:\n{{sections}}\nReturn {\"sections\":[{\"id\":\"existing id\",\"content\":\"replacement inner HTML\",\"label\":\"optional\"}]}. Do not create a new site or alter metadata visibility.",
        "as": "refinement_json",
        "maxTokens": 1600
      }
    },
    {
      "tool": "parse_json",
      "bind": "refinement",
      "inputs": { "items": { "$ref": "refinementDraft.items" }, "field": "refinement_json", "as": "plan" }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "updatedSections",
      "inputs": { "url": { "$param": "mcp_url" }, "tool": "bulk_update_sections", "args": { "session_id": { "$param": "session_id" }, "sections": { "$ref": "refinement.items.0.plan.sections" } } }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "qualityAfter",
      "inputs": { "url": { "$param": "mcp_url" }, "tool": "get_quality_report", "args": { "session_id": { "$param": "session_id" } } }
    },
    {
      "tool": "map",
      "bind": "gate",
      "inputs": {
        "items": [{ "ready": { "$ref": "qualityAfter.data.ready_for_human_review" } }],
        "keep": ["ready"],
        "derive": {
          "passed": { "$cond": { "field": "ready", "op": "truthy" }, "then": true, "else": false },
          "needs_attention": { "$cond": { "field": "ready", "op": "falsy" }, "then": true, "else": false },
          "state": { "$cond": { "field": "ready", "op": "truthy" }, "then": "qa_passed", "else": "needs_attention" }
        }
      }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "desktopCapture",
      "inputs": { "url": { "$param": "mcp_url" }, "tool": "capture_preview", "args": { "session_id": { "$param": "session_id" }, "viewport": "desktop" } }
    },
    {
      "tool": "mcp_call_tool",
      "bind": "mobileCapture",
      "inputs": { "url": { "$param": "mcp_url" }, "tool": "capture_preview", "args": { "session_id": { "$param": "session_id" }, "viewport": "mobile" } }
    },
    {
      "tool": "create_ticket",
      "bind": "approval",
      "when": { "$ref": "gate.items.0.passed" },
      "inputs": {
        "title": "Deploy the refined site for review",
        "reasoning": "Reviewer feedback was applied to the existing noindex FWS session. FWS diagnostics now pass and desktop/mobile captures were collected. Nothing is live; approval deploys this same session only.",
        "action": "run_pipeline",
        "config": { "pipeline": "site-deploy" },
        "params": {
          "session_id": { "$param": "session_id" }, "place_id": { "$param": "place_id" }, "mcp_url": { "$param": "mcp_url" }, "name": { "$param": "name" }, "slug": { "$param": "slug" }, "category": { "$param": "category" }, "description": { "$param": "description" }, "suburb": { "$param": "suburb" }, "address": { "$param": "address" }, "phone": { "$param": "phone" }, "email": { "$param": "email" }
        }
      }
    },
    {
      "tool": "map",
      "bind": "evidence",
      "inputs": {
        "items": [{ "place_id": { "$param": "place_id" }, "session_id": { "$param": "session_id" }, "quality_before": { "$ref": "qualityBefore.data" }, "quality_after": { "$ref": "qualityAfter.data" }, "desktop_capture": { "$ref": "desktopCapture.data" }, "mobile_capture": { "$ref": "mobileCapture.data" }, "gate": { "$ref": "gate.items.0" }, "prior_iteration_count": { "$param": "prior_iteration_count" } }],
        "extract": { "place_id": "place_id", "site_session_id": "session_id", "review_quality_before": "quality_before", "review_quality_after": "quality_after", "desktop_capture": "desktop_capture", "mobile_capture": "mobile_capture", "site_state": "gate.state", "prior_iteration_count": "prior_iteration_count" }
      }
    },
    {
      "tool": "map",
      "bind": "approvedRecord",
      "when": { "$ref": "gate.items.0.passed" },
      "inputs": { "items": { "$ref": "evidence.items" }, "derive": { "site_status": "awaiting_approval" } }
    },
    {
      "tool": "dedupe_upsert",
      "bind": "storedApproved",
      "when": { "$ref": "gate.items.0.passed" },
      "inputs": { "items": { "$ref": "approvedRecord.items" }, "collection": "sites", "key": "place_id", "mode": "update", "emit": "site.drafted" }
    },
    {
      "tool": "create_ticket",
      "bind": "needsAttention",
      "when": { "$ref": "gate.items.0.needs_attention" },
      "inputs": { "title": "Website draft needs attention", "status": "needs_human", "reasoning": "Reviewer feedback was applied to the existing noindex session, but FWS QA still fails. Nothing was deployed; continue using this same session." }
    },
    {
      "tool": "map",
      "bind": "needsAttentionRecord",
      "when": { "$ref": "gate.items.0.needs_attention" },
      "inputs": { "items": { "$ref": "evidence.items" }, "derive": { "site_status": "needs_attention" } }
    },
    {
      "tool": "dedupe_upsert",
      "bind": "storedNeedsAttention",
      "when": { "$ref": "gate.items.0.needs_attention" },
      "inputs": { "items": { "$ref": "needsAttentionRecord.items" }, "collection": "sites", "key": "place_id", "mode": "update", "emit": "site.needs_attention" }
    }
  ],
  "sink": { "collection": "sites", "keyField": "place_id" }
}')
    ),
    updated_at = datetime('now')
WHERE slug = 'site-builder';

UPDATE agent_instances
SET config = json_set(
      json_set(
        json_set(
          CASE WHEN json_valid(config) THEN config ELSE '{}' END,
          '$.pipelinesReplaced',
          json(COALESCE(json_extract(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.pipelinesReplaced'), '{}'))
        ),
        '$.pipelinesReplaced.site-builder-v2',
        json(json_extract(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.pipelines.site-builder'))
      ),
      '$.pipelines.site-builder',
      json((SELECT json_extract(CASE WHEN json_valid(a.config) THEN a.config ELSE '{}' END, '$.pipelines.site-builder')
              FROM agents a
             WHERE a.slug = 'site-builder')),
      '$.pipelines.site-refine',
      json((SELECT json_extract(CASE WHEN json_valid(a.config) THEN a.config ELSE '{}' END, '$.pipelines.site-refine')
              FROM agents a
             WHERE a.slug = 'site-builder'))
    ),
    updated_at = datetime('now')
WHERE agent_id IN (SELECT id FROM agents WHERE slug = 'site-builder')
  AND json_extract(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.pipelines.site-builder.steps[36].bind') = 'preview2'
  AND json_extract(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.pipelines.site-builder.steps[36].inputs.tool') = 'get_rendered_preview'
  AND json_extract(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.pipelines.site-builder.steps[43].bind') = 'review';
